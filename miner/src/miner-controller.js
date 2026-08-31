import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const GPU_WORKER_PATH = fileURLToPath(new URL("./gpu-worker.js", import.meta.url));
const GPU_HASHRATE_KEY = "gpu"; // child_process has no threadId; use a fixed key in the hashrates map

/**
 * Orchestrates the mining threads, challenge polling, and share submission.
 * Used by both the plain CLI (src/index.js) and the local control UI
 * (src/server.js) so they share one code path instead of duplicating it.
 */
export class MinerController {
  constructor() {
    this.workers = [];
    this.gpuWorker = null;
    this.gpuActive = false;
    this.gpuRestartCount = 0;
    this.hashrates = new Map();
    this.currentChallenge = null;
    this.sharesAccepted = 0;
    this.sharesRejected = 0;
    this.capped = false;
    this.running = false;
    this.config = null;
    this.challengeTimer = null;
    this.lastReactiveRefresh = 0;
    this.lastError = null;
  }

  getStatus() {
    const hashrate = [...this.hashrates.values()].reduce((sum, h) => sum + h, 0);
    return {
      running: this.running,
      address: this.config?.address ?? null,
      api: this.config?.api ?? null,
      workers: this.config?.workers ?? 0,
      gpuRequested: this.config?.gpu ?? false,
      gpuActive: this.gpuActive,
      hashrate,
      sharesAccepted: this.sharesAccepted,
      sharesRejected: this.sharesRejected,
      capped: this.capped,
      lastError: this.lastError,
    };
  }

  start(config) {
    if (this.running) throw new Error("already mining — stop first");
    if (typeof config.address !== "string" || !config.address.startsWith("albus1")) {
      throw new Error("a valid albus1... address is required");
    }
    const workers = Number(config.workers) || cpus().length;
    if (workers < 1 || workers > cpus().length * 2) {
      throw new Error(`workers must be between 1 and ${cpus().length * 2}`);
    }

    this.config = {
      address: config.address,
      api: config.api || "http://localhost:4000",
      workers,
      gpu: config.gpu !== false, // best-effort by default; falls back to CPU-only if no GPU adapter
      // Must stay comfortably below the server's epoch length — see
      // src/index.js for why.
      interval: Number(config.interval) || 4000,
    };
    this.sharesAccepted = 0;
    this.sharesRejected = 0;
    this.capped = false;
    this.currentChallenge = null;
    this.lastReactiveRefresh = 0;
    this.lastError = null;
    this.gpuActive = false;
    this.hashrates.clear();
    this.running = true;

    for (let i = 0; i < this.config.workers; i++) {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { workerId: i, stride: this.config.workers },
      });
      worker.on("message", (msg) => this._handleWorkerMessage(worker.threadId, msg));
      worker.on("error", (err) => {
        this.lastError = err.message;
      });
      this.workers.push(worker);
    }

    this.gpuRestartCount = 0;
    if (this.config.gpu) this._spawnGpuWorker();

    void this._refreshChallenge();
    this.challengeTimer = setInterval(() => void this._refreshChallenge(), this.config.interval);
  }

  // A separate OS process, not a worker_thread: this Node WebGPU binding
  // (Dawn via the `webgpu` package) is not fully stable under sustained use —
  // verified via a standalone stress test that it can crash with an access
  // violation after a few thousand dispatch/readback cycles, independent of
  // anything else running in the process. That's a third-party native-binding
  // issue, not a bug in the mining kernel itself (which has been validated
  // bit-exact against Node's own crypto across tens of thousands of samples
  // with zero invalid shares). Since a crash can't be prevented outright, the
  // process isolation contains its blast radius, and this method's restart
  // logic (see the "exit" handler) papers over the instability by respawning
  // — up to a limit, beyond which it gives up and stays CPU-only.
  _spawnGpuWorker() {
    const MAX_RESTARTS = 5;
    const gpuWorker = fork(GPU_WORKER_PATH, { stdio: ["ignore", "inherit", "inherit", "ipc"] });

    gpuWorker.on("message", (msg) => {
      if (msg.type === "ready") {
        this.gpuActive = true;
        // Rearm whatever job is currently in flight — a freshly (re)spawned
        // process starts with none.
        if (this.currentChallenge) {
          gpuWorker.send({
            type: "job",
            seed: this.currentChallenge.seed,
            difficulty: this.currentChallenge.difficulty,
            address: this.config.address,
          });
        }
      } else if (msg.type === "gpu-error") {
        // No compatible GPU/driver, or the job format didn't match what the
        // kernel hardcodes — fall back to CPU-only rather than fail the
        // whole miner.
        this.lastError = `GPU mining unavailable: ${msg.error}`;
        this.gpuActive = false;
        this.hashrates.delete(GPU_HASHRATE_KEY);
      } else {
        this._handleWorkerMessage(GPU_HASHRATE_KEY, msg);
      }
    });
    gpuWorker.on("error", (err) => {
      this.lastError = `GPU mining unavailable: ${err.message}`;
      this.gpuActive = false;
    });
    gpuWorker.on("exit", (code) => {
      if (!this.running || this.gpuWorker !== gpuWorker) return; // stop() already handled cleanup
      this.gpuActive = false;
      this.hashrates.delete(GPU_HASHRATE_KEY);
      if (code === 0) return;

      this.gpuRestartCount++;
      if (this.gpuRestartCount > MAX_RESTARTS) {
        this.lastError = `GPU mining disabled after ${MAX_RESTARTS} crashes (last exit code ${code}) — continuing CPU-only`;
        this.gpuWorker = null;
        return;
      }
      this.lastError = `GPU mining process crashed (code ${code}), restarting (${this.gpuRestartCount}/${MAX_RESTARTS})...`;
      this._spawnGpuWorker();
    });

    this.gpuWorker = gpuWorker;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.challengeTimer);
    this.challengeTimer = null;
    for (const worker of this.workers) {
      worker.postMessage({ type: "stop" });
      void worker.terminate();
    }
    this.workers = [];
    if (this.gpuWorker) {
      this.gpuWorker.removeAllListeners("exit"); // avoid the "unexpected exit" branch firing on our own shutdown
      this.gpuWorker.send({ type: "stop" });
      this.gpuWorker.kill();
      this.gpuWorker = null;
    }
    this.gpuActive = false;
    this.hashrates.clear();
  }

  _handleWorkerMessage(hashrateKey, msg) {
    if (msg.type === "hashrate") {
      this.hashrates.set(hashrateKey, msg.hashesPerSecond);
    } else if (msg.type === "share") {
      if (msg.seed !== this.currentChallenge?.seed) return; // stale share from a just-rotated epoch
      if (this.capped) return;
      this._submitShare(msg.nonce)
        .then((res) => {
          if (res.ok) {
            this.sharesAccepted++;
          } else {
            this.sharesRejected++;
            if (res.error === "share limit reached for this epoch") this.capped = true;
            else if (res.error === "share does not meet difficulty") this._refreshChallengeReactively();
          }
        })
        .catch((err) => {
          this.sharesRejected++;
          this.lastError = err.message;
        });
    }
  }

  _refreshChallengeReactively() {
    const now = Date.now();
    if (now - this.lastReactiveRefresh < 500) return;
    this.lastReactiveRefresh = now;
    void this._refreshChallenge();
  }

  async _refreshChallenge() {
    if (!this.running) return;
    try {
      const res = await fetch(`${this.config.api}/mining/challenge`);
      const challenge = await res.json();
      if (challenge.seed !== this.currentChallenge?.seed) {
        this.currentChallenge = challenge;
        this.capped = false;
        const jobMsg = {
          type: "job",
          seed: challenge.seed,
          difficulty: challenge.difficulty,
          address: this.config.address,
        };
        for (const worker of this.workers) worker.postMessage(jobMsg);
        if (this.gpuWorker) this.gpuWorker.send(jobMsg);
      }
    } catch (err) {
      this.lastError = `failed to fetch mining challenge: ${err.message}`;
    }
  }

  async _submitShare(nonce) {
    const res = await fetch(`${this.config.api}/mining/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: this.config.address, nonce }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error };
  }
}

export async function generateWallet(api) {
  const res = await fetch(`${api}/wallet`, { method: "POST" });
  if (!res.ok) throw new Error(`wallet generation failed: ${res.status}`);
  return res.json();
}
