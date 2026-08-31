import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

/**
 * Orchestrates the mining threads, challenge polling, and share submission.
 * Used by both the plain CLI (src/index.js) and the local control UI
 * (src/server.js) so they share one code path instead of duplicating it.
 */
export class MinerController {
  constructor() {
    this.workers = [];
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
    this.hashrates.clear();
    this.running = true;

    for (let i = 0; i < this.config.workers; i++) {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { workerId: i, stride: this.config.workers },
      });
      worker.on("message", (msg) => this._handleWorkerMessage(worker, msg));
      worker.on("error", (err) => {
        this.lastError = err.message;
      });
      this.workers.push(worker);
    }

    void this._refreshChallenge();
    this.challengeTimer = setInterval(() => void this._refreshChallenge(), this.config.interval);
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
    this.hashrates.clear();
  }

  _handleWorkerMessage(worker, msg) {
    if (msg.type === "hashrate") {
      this.hashrates.set(worker.threadId, msg.hashesPerSecond);
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
        for (const worker of this.workers) {
          worker.postMessage({
            type: "job",
            seed: challenge.seed,
            difficulty: challenge.difficulty,
            address: this.config.address,
          });
        }
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
