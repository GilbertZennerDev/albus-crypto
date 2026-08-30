import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { readJson, writeJsonAtomic } from "./storage.js";

const SHARES_FILE = process.env.SHARES_DATA_FILE ?? "data/shares.json";
export const SHARE_DIFFICULTY = Number(process.env.SHARE_DIFFICULTY ?? 4);

// Anti-Sybil: shares are cheap to fake at scale by generating many wallets
// from one machine, since the difficulty check alone doesn't tie work to a
// device. Capping total shares credited per source IP per epoch means
// splitting across wallets doesn't multiply payout — the IP's total stays
// bounded regardless of how many addresses submit under it.
const MAX_SHARES_PER_IP_PER_EPOCH = Number(process.env.MAX_SHARES_PER_IP_PER_EPOCH ?? 500);

interface ShareState {
  seed: string;
  shares: Record<string, number>;
  ipShares: Record<string, number>;
  seenNonces: string[];
}

function newSeed(): string {
  return bytesToHex(randomBytes(16));
}

export class MiningPool {
  private state: ShareState;

  constructor() {
    this.state = readJson<ShareState>(SHARES_FILE) ?? { seed: newSeed(), shares: {}, ipShares: {}, seenNonces: [] };
  }

  private persist(): void {
    writeJsonAtomic(SHARES_FILE, this.state);
  }

  getChallenge(): { seed: string; difficulty: number } {
    return { seed: this.state.seed, difficulty: SHARE_DIFFICULTY };
  }

  getShares(): Record<string, number> {
    return this.state.shares;
  }

  submitShare(
    address: string,
    nonce: string,
    ip: string,
  ): { ok: true; totalShares: number } | { ok: false; error: string } {
    if (typeof address !== "string" || !address.startsWith("albus1")) {
      return { ok: false, error: "invalid address" };
    }
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 32) {
      return { ok: false, error: "invalid nonce" };
    }
    if ((this.state.ipShares[ip] ?? 0) >= MAX_SHARES_PER_IP_PER_EPOCH) {
      return { ok: false, error: "share limit reached for this epoch" };
    }
    const key = `${address}:${nonce}`;
    if (this.state.seenNonces.includes(key)) return { ok: false, error: "duplicate share" };

    const hash = bytesToHex(sha256(utf8ToBytes(`${this.state.seed}|${address}|${nonce}`)));
    if (!hash.startsWith("0".repeat(SHARE_DIFFICULTY))) {
      return { ok: false, error: "share does not meet difficulty" };
    }

    this.state.shares[address] = (this.state.shares[address] ?? 0) + 1;
    this.state.ipShares[ip] = (this.state.ipShares[ip] ?? 0) + 1;
    this.state.seenNonces.push(key);
    if (this.state.seenNonces.length > 5000) this.state.seenNonces = this.state.seenNonces.slice(-2000);
    this.persist();
    return { ok: true, totalShares: this.state.shares[address] };
  }

  /** Snapshot the current epoch's shares and start a fresh one (new seed, empty tally). */
  rotateEpoch(): Record<string, number> {
    const snapshot = this.state.shares;
    this.state = { seed: newSeed(), shares: {}, ipShares: {}, seenNonces: [] };
    this.persist();
    return snapshot;
  }
}
