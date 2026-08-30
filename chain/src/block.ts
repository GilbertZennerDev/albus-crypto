import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Transaction } from "./transaction.js";

export interface Block {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  nonce: number;
  difficulty: number;
  hash: string;
}

export function calculateBlockHash(
  index: number,
  timestamp: number,
  transactions: Transaction[],
  previousHash: string,
  nonce: number,
  difficulty: number,
): string {
  const payload = `${index}|${timestamp}|${JSON.stringify(transactions.map((t) => t.id))}|${previousHash}|${nonce}|${difficulty}`;
  return bytesToHex(sha256(utf8ToBytes(payload)));
}

export function createGenesisBlock(genesisTx: Transaction): Block {
  const index = 0;
  const timestamp = Date.now();
  const previousHash = "0".repeat(64);
  const nonce = 0;
  const difficulty = 0;
  const hash = calculateBlockHash(index, timestamp, [genesisTx], previousHash, nonce, difficulty);
  return { index, timestamp, transactions: [genesisTx], previousHash, nonce, difficulty, hash };
}

export function mineBlock(
  index: number,
  transactions: Transaction[],
  previousHash: string,
  difficulty: number,
): Block {
  const timestamp = Date.now();
  const target = "0".repeat(difficulty);
  let nonce = 0;
  let hash = calculateBlockHash(index, timestamp, transactions, previousHash, nonce, difficulty);
  while (!hash.startsWith(target)) {
    nonce++;
    hash = calculateBlockHash(index, timestamp, transactions, previousHash, nonce, difficulty);
  }
  return { index, timestamp, transactions, previousHash, nonce, difficulty, hash };
}

export function isBlockHashValid(block: Block): boolean {
  const recomputed = calculateBlockHash(
    block.index,
    block.timestamp,
    block.transactions,
    block.previousHash,
    block.nonce,
    block.difficulty,
  );
  if (recomputed !== block.hash) return false;
  return block.hash.startsWith("0".repeat(block.difficulty));
}
