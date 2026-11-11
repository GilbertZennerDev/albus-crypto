import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { addressBytes, concatBytes, hexFixedBytes, tagBytes, u16be, u32be, u64be } from "./bin.js";
import type { Transaction } from "./transaction.js";
import { GENESIS_MESSAGE, GENESIS_TIMESTAMP } from "./params.js";
import { hashBelowTarget } from "./difficulty.js";

export { workOf } from "./difficulty.js";

export interface Block {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  nonce: string;
  difficulty: number;
  hash: string;
  seed: string;
  proofAddress: string;
}

const sha256Hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

export const NONCE_RE = /^[0-9a-f]{16}$/;
export const SEED_RE = /^[0-9a-f]{64}$/;
export const nonceHex = (n: number | bigint): string => n.toString(16).padStart(16, "0");

export function proofInner(seed: string, address: string): Uint8Array {
  return sha256(concatBytes(hexFixedBytes(seed, 32), addressBytes(address)));
}

export function calculateProofHash(seed: string, address: string, nonce: string): string {
  return bytesToHex(sha256(concatBytes(proofInner(seed, address), hexFixedBytes(nonce, 8))));
}

export function hashMeetsDifficulty(hash: string, difficulty: number): boolean {
  return hashBelowTarget(hash, difficulty);
}

export function hashHasHexZeros(hash: string, zeros: number): boolean {
  return hash.startsWith("0".repeat(zeros));
}

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const withPrefix = (tag: number, ...parts: Uint8Array[]) => {
  const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0));
  out[0] = tag;
  let o = 1;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function merkleLeaf(t: Transaction): string {
  return bytesToHex(sha256(withPrefix(0, hexBytes(t.id), hexBytes(t.signature ?? ""))));
}

export function merkleParent(left: string, right: string): string {
  return bytesToHex(sha256(withPrefix(1, hexBytes(left), hexBytes(right))));
}

export function transactionRoot(txs: Transaction[]): string {
  if (txs.length === 0) return sha256Hex("albus-empty-merkle");
  let level = txs.map(merkleLeaf);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? merkleParent(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export function merkleProof(txs: Transaction[], index: number): { side: "l" | "r"; hash: string }[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= txs.length) return null;
  let level = txs.map(merkleLeaf);
  let i = index;
  const proof: { side: "l" | "r"; hash: string }[] = [];
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push({ side: sib < i ? "l" : "r", hash: level[sib] });
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? merkleParent(level[k], level[k + 1]) : level[k]);
    level = next;
    i >>= 1;
  }
  return proof;
}

export function verifyMerkleProof(tx: Transaction, proof: { side: "l" | "r"; hash: string }[], root: string): boolean {
  let h = merkleLeaf(tx);
  for (const p of proof) h = p.side === "l" ? merkleParent(p.hash, h) : merkleParent(h, p.hash);
  return h === root;
}

export function computeSeedFromRoot(previousHash: string, index: number, timestamp: number, difficulty: number, root: string): string {
  return bytesToHex(
    sha256(concatBytes(tagBytes("albus-v4-seed"), hexFixedBytes(previousHash, 32), u32be(index), u64be(timestamp), u16be(difficulty), hexFixedBytes(root, 32))),
  );
}

export function computeSeed(
  previousHash: string,
  index: number,
  timestamp: number,
  difficulty: number,
  txs: Transaction[],
): string {
  return computeSeedFromRoot(previousHash, index, timestamp, difficulty, transactionRoot(txs));
}

export interface BlockHeader {
  index: number;
  timestamp: number;
  previousHash: string;
  nonce: string;
  difficulty: number;
  hash: string;
  seed: string;
  proofAddress: string;
  transactionRoot: string;
}

export function headerOf(b: Block): BlockHeader {
  return {
    index: b.index,
    timestamp: b.timestamp,
    previousHash: b.previousHash,
    nonce: b.nonce,
    difficulty: b.difficulty,
    hash: b.hash,
    seed: b.seed,
    proofAddress: b.proofAddress,
    transactionRoot: transactionRoot(b.transactions),
  };
}

export function createGenesisBlock(): Block {
  return {
    index: 0,
    timestamp: GENESIS_TIMESTAMP,
    transactions: [],
    previousHash: "0".repeat(64),
    nonce: "0".repeat(16),
    difficulty: 0,
    hash: sha256Hex(`genesis|${GENESIS_MESSAGE}`),
    seed: "",
    proofAddress: "",
  };
}

export function buildProvenBlock(
  index: number,
  timestamp: number,
  transactions: Transaction[],
  previousHash: string,
  difficulty: number,
  seed: string,
  proofAddress: string,
  nonce: string,
): Block {
  const hash = calculateProofHash(seed, proofAddress, nonce);
  return { index, timestamp, transactions, previousHash, nonce, difficulty, hash, seed, proofAddress };
}
