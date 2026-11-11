import type { Blockchain, Template } from "./blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, nonceHex } from "./block.js";

const BATCH = 4000;
const REFRESH_MS = 10_000;

export class CpuMiner {
  private template: Template | null = null;
  private builtAt = 0;
  private counter = Math.floor(Math.random() * 2 ** 32);
  private running = false;
  hashes = 0;
  blocks = 0;

  constructor(private chain: Blockchain, private address: string, private throttleMs = 0, private invitation?: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
  }

  private tick = (): void => {
    if (!this.running) return;
    if (!this.template || this.template.previousHash !== this.chain.tip.hash || Date.now() - this.builtAt > REFRESH_MS) {
      this.template = this.chain.buildTemplate(this.address, this.invitation);
      this.builtAt = Date.now();
    }
    const t = this.template;
    for (let i = 0; i < BATCH; i++) {
      const nonce = nonceHex(this.counter++);
      this.hashes++;
      if (hashMeetsDifficulty(calculateProofHash(t.seed, this.address, nonce), t.difficulty)) {
        const { result, block } = this.chain.submitSolved(t, nonce);
        if (result.status === "added") {
          this.blocks++;
          console.log(`cpu-miner: Block ${block.index} gefunden (${block.hash.slice(0, 16)}...)`);
        }
        this.template = null;
        break;
      }
    }
    if (this.throttleMs > 0) setTimeout(this.tick, this.throttleMs);
    else setImmediate(this.tick);
  };
}
