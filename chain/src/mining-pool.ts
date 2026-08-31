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
//
// This has to be tuned against real hashrate, not just "high enough to feel
// safe": a native CLI miner (see ../miner/) can find on the order of 1e5-1e6
// qualifying shares per epoch at low SHARE_DIFFICULTY, so a cap sized for
// browser-JS hashing would throttle a single legitimate fast miner almost
// immediately. Raise SHARE_DIFFICULTY in production to bring real share
// volume down instead of raising this arbitrarily high.
const MAX_SHARES_PER_IP_PER_EPOCH = Number(process.env.MAX_SHARES_PER_IP_PER_EPOCH ?? 100_000);

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
  // Dedup set for the current epoch — kept separate from state.seenNonces
  // (which is just the persisted snapshot) so the hot path is an O(1) Set
  // lookup instead of the O(n) Array.includes scan this used to do on every
  // single share, which was measurably slow at real mining volume.
  private seenNonces: Set<string>;

  constructor() {
    this.state = readJson<ShareState>(SHARES_FILE) ?? { seed: newSeed(), shares: {}, ipShares: {}, seenNonces: [] };
    this.seenNonces = new Set(this.state.seenNonces);
  }

  // Persisting on every accepted share meant hundreds-to-thousands of atomic
  // disk writes per second under real mining load — needless I/O, and on at
  // least one filesystem (Windows, rename-over-existing) frequent enough to
  // hit a transient EPERM and crash the whole process. Shares are ephemeral
  // within an epoch anyway (same tradeoff as the in-memory-only mempool), so
  // only rotateEpoch persists — losing at most one in-flight epoch's tally
  // on a crash is an acceptable cost for not risking the server's stability
  // on every share.
  private persist(): void {
    this.state.seenNonces = [...this.seenNonces];
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
    if (typeof address !== "string" || !/^albus1[0-9a-f]{40}$/.test(address)) {
      return { ok: false, error: "invalid address" };
    }
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 32) {
      return { ok: false, error: "invalid nonce" };
    }
    if ((this.state.ipShares[ip] ?? 0) >= MAX_SHARES_PER_IP_PER_EPOCH) {
      return { ok: false, error: "share limit reached for this epoch" };
    }
    const key = `${address}:${nonce}`;
    if (this.seenNonces.has(key)) return { ok: false, error: "duplicate share" };

    const hash = bytesToHex(sha256(utf8ToBytes(`${this.state.seed}|${address}|${nonce}`)));
    if (!hash.startsWith("0".repeat(SHARE_DIFFICULTY))) {
      return { ok: false, error: "share does not meet difficulty" };
    }

    this.state.shares[address] = (this.state.shares[address] ?? 0) + 1;
    this.state.ipShares[ip] = (this.state.ipShares[ip] ?? 0) + 1;
    this.seenNonces.add(key);
    return { ok: true, totalShares: this.state.shares[address] };
  }

  /** Snapshot the current epoch's shares and start a fresh one (new seed, empty tally). */
  rotateEpoch(): Record<string, number> {
    const snapshot = this.state.shares;
    this.state = { seed: newSeed(), shares: {}, ipShares: {}, seenNonces: [] };
    this.seenNonces = new Set();
    this.persist();
    return snapshot;
  }
}
