import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { readJson, writeJsonAtomic } from "./storage.js";
import { hashMeetsDifficulty } from "./block.js";

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
const MAX_SHARES_PER_IP_PER_EPOCH = Number(process.env.MAX_SHARES_PER_IP_PER_EPOCH ?? 2_000_000);

export const MAX_BATCH_SIZE = 5000;

interface ShareState {
  seed: string;
  shares: Record<string, number>;
  ipShares: Record<string, number>;
  seenNonces: string[];
}

export interface ShareResult {
  ok: boolean;
  error?: string;
  totalShares?: number;
  /** True when this share's hash also clears the real block-finding difficulty. */
  blockFound?: boolean;
  nonce?: string;
}

/**
 * Anti-Sybil share accounting for whatever job the blockchain currently
 * publishes. The pool no longer generates its own seed (see
 * Blockchain.getCurrentJob) — a share here IS a candidate block
 * proof-of-work, just checked against a lower bar for fairness/anti-spam
 * accounting before also being checked against the real block difficulty.
 */
export class MiningPool {
  private state: ShareState;
  // Dedup set for the current epoch — kept separate from state.seenNonces
  // (which is just the persisted snapshot) so the hot path is an O(1) Set
  // lookup instead of the O(n) Array.includes scan this used to do on every
  // single share, which was measurably slow at real mining volume.
  private seenNonces: Set<string>;

  constructor() {
    this.state = readJson<ShareState>(SHARES_FILE) ?? { seed: "", shares: {}, ipShares: {}, seenNonces: [] };
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

  getSeed(): string {
    return this.state.seed;
  }

  getChallenge(difficulty: number): { seed: string; difficulty: number } {
    return { seed: this.state.seed, difficulty: SHARE_DIFFICULTY < difficulty ? SHARE_DIFFICULTY : difficulty };
  }

  getShares(): Record<string, number> {
    return this.state.shares;
  }

  /** Called whenever the chain head/mempool changes and a new job is published — starts a fresh epoch. */
  setJob(seed: string): void {
    if (seed === this.state.seed) return;
    this.state = { seed, shares: {}, ipShares: {}, seenNonces: [] };
    this.seenNonces = new Set();
    this.persist();
  }

  submitShare(address: string, nonce: string, ip: string, blockDifficulty: number): ShareResult {
    if (typeof address !== "string" || !/^albus1[0-9a-f]{40}$/.test(address)) {
      return { ok: false, error: "invalid address" };
    }
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 32) {
      return { ok: false, error: "invalid nonce" };
    }
    const key = `${address}:${nonce}`;
    if (this.seenNonces.has(key)) return { ok: false, error: "duplicate share" };

    const hash = bytesToHex(sha256(utf8ToBytes(`${this.state.seed}|${address}|${nonce}`)));
    if (!hashMeetsDifficulty(hash, SHARE_DIFFICULTY)) {
      return { ok: false, error: "share does not meet difficulty" };
    }

    // The IP cap only guards against cheaply-faked low-bar shares (Sybil
    // accounting padding) — a share that also clears the real, much harder
    // block difficulty is genuine rare proof-of-work and must never be
    // dropped for being "over quota", or a capped dominant miner could stall
    // the whole chain (no share through means no block through) until the
    // fallback timer eventually resets the epoch.
    const blockFound = hashMeetsDifficulty(hash, blockDifficulty);
    if (!blockFound && (this.state.ipShares[ip] ?? 0) >= MAX_SHARES_PER_IP_PER_EPOCH) {
      return { ok: false, error: "share limit reached for this epoch" };
    }

    this.state.shares[address] = (this.state.shares[address] ?? 0) + 1;
    this.state.ipShares[ip] = (this.state.ipShares[ip] ?? 0) + 1;
    this.seenNonces.add(key);
    return { ok: true, totalShares: this.state.shares[address], blockFound, nonce };
  }

  /**
   * Batched submission: a fast miner can find thousands of shares per
   * second, and one HTTP round trip per share was overwhelming both client
   * and server connection handling at real hashrates. This is just
   * submitShare() looped — same validation, same dedup, same cap — so
   * correctness and fairness (every real share still counted) are
   * unchanged; only the request count drops.
   */
  submitShares(
    address: string,
    nonces: string[],
    ip: string,
    blockDifficulty: number,
  ): { accepted: number; rejected: number; lastError?: string; blockFoundNonce?: string } {
    let accepted = 0;
    let rejected = 0;
    let lastError: string | undefined;
    let blockFoundNonce: string | undefined;
    for (const nonce of nonces) {
      const result = this.submitShare(address, nonce, ip, blockDifficulty);
      if (result.ok) {
        accepted++;
        if (result.blockFound && !blockFoundNonce) blockFoundNonce = result.nonce;
      } else {
        rejected++;
        lastError = result.error;
      }
    }
    return { accepted, rejected, lastError, blockFoundNonce };
  }

  /** Snapshot the current epoch's shares (used right before a block is finalized and a new job starts). */
  snapshotShares(): Record<string, number> {
    return this.state.shares;
  }
}
