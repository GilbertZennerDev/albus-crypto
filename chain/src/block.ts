import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Transaction } from "./transaction.js";

export interface Block {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  nonce: string;
  difficulty: number;
  hash: string;
  /** The job seed and finder address the proof-of-work hash was computed from — kept for self-contained validation. */
  seed: string;
  proofAddress: string;
}

/**
 * A block's proof-of-work IS a mining-pool share: the same
 * sha256(seed|address|nonce) puzzle miners already solve. `seed` binds the
 * block to exact chain state (see Blockchain.getCurrentJob) and `address` is
 * whichever miner's share crossed BLOCK_DIFFICULTY, so no separate
 * server-side brute force is needed — the miner already did the work.
 */
export function calculateProofHash(seed: string, address: string, nonce: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${seed}|${address}|${nonce}`)));
}

export function hashMeetsDifficulty(hash: string, difficulty: number): boolean {
  return hash.startsWith("0".repeat(difficulty));
}

export function createGenesisBlock(genesisTx: Transaction): Block {
  const index = 0;
  const timestamp = Date.now();
  const previousHash = "0".repeat(64);
  const nonce = "0";
  const difficulty = 0;
  const hash = bytesToHex(sha256(utf8ToBytes(`genesis|${genesisTx.id}`)));
  return { index, timestamp, transactions: [genesisTx], previousHash, nonce, difficulty, hash, seed: "", proofAddress: "" };
}

/**
 * Builds a block from a proven (seed, address, nonce) triple — the miner
 * already found a nonce whose hash clears `difficulty`; this just packages
 * that proof together with the transactions it was mined for.
 */
export function buildProvenBlock(
  index: number,
  transactions: Transaction[],
  previousHash: string,
  difficulty: number,
  seed: string,
  proofAddress: string,
  nonce: string,
): Block {
  const hash = calculateProofHash(seed, proofAddress, nonce);
  const timestamp = Date.now();
  return { index, timestamp, transactions, previousHash, nonce, difficulty, hash, seed, proofAddress };
}

export function isBlockHashValid(block: Block): boolean {
  if (block.index === 0) return true; // genesis has no PoW
  const recomputed = calculateProofHash(block.seed, block.proofAddress, block.nonce);
  if (recomputed !== block.hash) return false;
  return hashMeetsDifficulty(block.hash, block.difficulty);
}
