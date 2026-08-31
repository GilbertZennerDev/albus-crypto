import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const GPU_WORKER_PATH = fileURLToPath(new URL("./gpu-worker.js", import.meta.url));
const GPU_HASHRATE_KEY = "gpu"; // child_process has no threadId; use a fixed key in the hashrates map
const GPU_DEFAULT_BATCH = 2_097_152;
const GPU_MIN_BATCH = 65_536;
const GPU_RESTART_DELAY_MS = 1500; // let the OS/driver fully release GPU resources before respawning
const GPU_STABILITY_RESET_MS = 60_000; // this long without a crash resets the retry budget and batch size
const SHARE_BATCH_FLUSH_MS = 200;
const SHARE_BATCH_MAX_SIZE = 5000; // must match the server's MAX_BATCH_SIZE

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
    this.gpuBatchSize = GPU_DEFAULT_BATCH;
    this.gpuStabilityTimer = null;
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
    // Found shares are buffered and flushed in batches instead of one HTTP
    // request per share — at real hashrates that's thousands of requests per
    // second, which overwhelms connection handling on both ends (see
    // src/index.ts's /mining/submit-batch for the server side).
    this.pendingNonces = [];
    this.batchFlushTimer = null;
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
      gpuBatchSize: this.gpuBatchSize,
      hashrate,
      sharesAccepted: this.sharesAccepted,
      sharesRejected: this.sharesRejected,
      capped: this.capped,
      lastError: this.lastError,
    };
  }

  start(config) {
    if (this.running) throw new Error("already mining — stop first");
    // A real address is always exactly "albus1" (6 chars) + 40 hex chars = 46
    // total. Checking only the prefix let a truncated/mis-copied address
    // (e.g. from wrapped terminal output) through, where it would surface
    // later as a confusing internal GPU-kernel error about byte lengths
    // instead of a clear message here.
    if (typeof config.address !== "string" || !/^albus1[0-9a-f]{40}$/.test(config.address)) {
      throw new Error(
        `a valid albus1... address is required (expected 46 characters, got ${config.address?.length ?? 0} — check it wasn't truncated when copied)`,
      );
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
    this.pendingNonces = [];
    this.running = true;

    this.batchFlushTimer = setInterval(() => void this._flushPendingShares(), SHARE_BATCH_FLUSH_MS);

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
    this.gpuBatchSize = Number(config.gpuBatchSize) || GPU_DEFAULT_BATCH;
    if (this.config.gpu) this._spawnGpuWorker();

    void this._refreshChallenge();
    this.challengeTimer = setInterval(() => void this._refreshChallenge(), this.config.interval);
  }

  // A separate OS process, not a worker_thread: this Node WebGPU binding
  // (Dawn via the `webgpu` package) is not fully stable under sustained use —
  // verified via a standalone stress test that it can crash with an access
  // violation independent of anything else running in the process, and in
  // the field this has shown up as "very unstable" on at least one RTX card,
  // still crashing even at the smallest batch size. That's a third-party
  // native-binding issue, not a bug in the mining kernel itself (validated
  // bit-exact against Node's own crypto across tens of thousands of samples
  // with zero invalid shares). Tried swapping to the wgpu-rs-based
  // `@sylphx/webgpu` to sidestep it entirely — reverted, since every
  // published version currently ships a macOS binary inside its Windows
  // package by mistake (upstream bug, see gpu-worker.js). Since a crash
  // can't be prevented outright here, this takes two complementary
  // approaches: process isolation contains the blast radius, and each
  // restart shrinks the per-dispatch batch size down to a floor, after which
  // it just keeps retrying indefinitely (CPU mining is unaffected either
  // way) — a card settles at whatever batch size it can actually sustain.
  _spawnGpuWorker() {
    const MAX_RESTARTS = 5;
    clearTimeout(this.gpuStabilityTimer);
    const gpuWorker = fork(GPU_WORKER_PATH, {
      env: { ...process.env, GPU_THREADS_PER_DISPATCH: String(this.gpuBatchSize) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    gpuWorker.on("message", (msg) => {
      if (this.gpuWorker !== gpuWorker) return; // a newer restart already superseded this one
      if (msg.type === "ready") {
        this.gpuActive = true;
        // Sustained stability resets the retry budget and batch size, so a
        // one-off crash early in a long session doesn't permanently cap
        // this run at a smaller, slower batch size forever.
        this.gpuStabilityTimer = setTimeout(() => {
          this.gpuRestartCount = 0;
          this.gpuBatchSize = GPU_DEFAULT_BATCH;
        }, GPU_STABILITY_RESET_MS);
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
      if (this.gpuWorker !== gpuWorker) return; // a newer restart already superseded this one
      this.lastError = `GPU mining unavailable: ${err.message}`;
      this.gpuActive = false;
    });
    gpuWorker.on("exit", (code) => {
      if (!this.running || this.gpuWorker !== gpuWorker) return; // stop() already handled cleanup
      clearTimeout(this.gpuStabilityTimer);
      this.gpuActive = false;
      this.hashrates.delete(GPU_HASHRATE_KEY);
      if (code === 0) return;

      this.gpuRestartCount++;
      const atFloor = this.gpuBatchSize <= GPU_MIN_BATCH;
      // Giving up outright after MAX_RESTARTS made sense when shrinking the
      // batch size was expected to eventually find a stable size — but if
      // it's still crashing at the floor batch size, that's not a batch-size
      // problem, it's the native GPU binding itself being unstable under
      // sustained use (confirmed via standalone stress testing). CPU mining
      // is unaffected either way, so there's no real cost to just retrying
      // forever at the floor size instead of permanently throwing away
      // whatever hashrate the GPU manages between crashes.
      if (!atFloor) {
        this.gpuBatchSize = Math.max(GPU_MIN_BATCH, Math.floor(this.gpuBatchSize / 2));
        this.lastError = `GPU mining process crashed (code ${code}), retrying at a smaller batch size (${this.gpuRestartCount}/${MAX_RESTARTS})...`;
      } else {
        this.lastError = `GPU mining process crashed (code ${code}) at the smallest batch size — this GPU/driver combination is unstable under sustained load; retrying indefinitely (CPU mining continues unaffected)`;
      }
      setTimeout(() => {
        if (this.running) this._spawnGpuWorker();
      }, GPU_RESTART_DELAY_MS);
    });

    this.gpuWorker = gpuWorker;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.challengeTimer);
    this.challengeTimer = null;
    clearInterval(this.batchFlushTimer);
    this.batchFlushTimer = null;
    this.pendingNonces = [];
    for (const worker of this.workers) {
      worker.postMessage({ type: "stop" });
      void worker.terminate();
    }
    this.workers = [];
    clearTimeout(this.gpuStabilityTimer);
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
      this.pendingNonces.push(msg.nonce);
    }
  }

  async _flushPendingShares() {
    if (this.pendingNonces.length === 0 || this.capped) return;
    // Batches are capped to match the server's limit — normally one flush
    // drains everything, this loop only matters if a flush was ever delayed
    // long enough for more than one batch's worth to pile up.
    while (this.pendingNonces.length > 0 && !this.capped) {
      const batch = this.pendingNonces.splice(0, SHARE_BATCH_MAX_SIZE);
      try {
        const res = await fetch(`${this.config.api}/mining/submit-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: this.config.address, nonces: batch }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        this.sharesAccepted += body.accepted;
        this.sharesRejected += body.rejected;
        if (body.lastError === "share limit reached for this epoch") this.capped = true;
        else if (body.lastError === "share does not meet difficulty") this._refreshChallengeReactively();
      } catch (err) {
        this.sharesRejected += batch.length;
        this.lastError = err.message;
      }
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
        this.pendingNonces = []; // shares still queued from the old epoch would just be rejected as stale
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
}

export async function generateWallet(api) {
  const res = await fetch(`${api}/wallet`, { method: "POST" });
  if (!res.ok) throw new Error(`wallet generation failed: ${res.status}`);
  return res.json();
}
