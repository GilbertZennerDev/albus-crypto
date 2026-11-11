import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { Block } from "./block.js";
import type { Transaction } from "./transaction.js";
import { ADDRESS_RE } from "./transaction.js";

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const MAX_TX_PER_BLOCK = 65_535;
const PUBKEY_MAX = 65;
const SIG_MAX = 80;
const SEED_BYTES = 32;

class Writer {
  private parts: number[] = [];
  u8(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error("u8 out of range");
    this.parts.push(n);
  }
  u16(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("u16 out of range");
    this.parts.push(n >>> 8, n & 0xff);
  }
  u32(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("u32 out of range");
    this.parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  u64(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("u64 out of range");
    let v = BigInt(n);
    const out = new Array<number>(8);
    for (let i = 7; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.parts.push(...out);
  }
  raw(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }
  hexFixed(hex: string, bytes: number): void {
    if (typeof hex !== "string" || hex.length !== bytes * 2 || !HEX_RE.test(hex)) throw new Error("hex field has the wrong shape");
    this.raw(hexToBytes(hex));
  }
  hexVar(hex: string, min: number, max: number): void {
    if (typeof hex !== "string" || !HEX_RE.test(hex) || hex.length / 2 < min || hex.length / 2 > max) throw new Error("hex field has the wrong shape");
    this.u8(hex.length / 2);
    this.raw(hexToBytes(hex));
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

class Reader {
  pos = 0;
  constructor(private b: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new Error("data too short");
  }
  u8(): number {
    this.need(1);
    return this.b[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = (this.b[this.pos] << 8) | this.b[this.pos + 1];
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = ((this.b[this.pos] << 24) | (this.b[this.pos + 1] << 16) | (this.b[this.pos + 2] << 8) | this.b[this.pos + 3]) >>> 0;
    this.pos += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.b[this.pos + i]);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("number too large");
    return Number(v);
  }
  hexFixed(bytes: number): string {
    this.need(bytes);
    const s = bytesToHex(this.b.subarray(this.pos, this.pos + bytes));
    this.pos += bytes;
    return s;
  }
  hexVar(min: number, max: number): string {
    const n = this.u8();
    if (n < min || n > max) throw new Error("field length out of range");
    return this.hexFixed(n);
  }
  end(): void {
    if (this.pos !== this.b.length) throw new Error("trailing bytes after the data");
  }
}

const addrBytes = (a: string): string => {
  if (!ADDRESS_RE.test(a)) throw new Error("invalid address");
  return a.slice(6);
};
const addrFrom = (hex: string): string => "albus1" + hex;

function writeTx(w: Writer, tx: Transaction): void {
  const coinbase = tx.fromPublicKey === null;
  const invited = tx.referrer !== undefined || tx.referrerKey !== undefined || tx.referrerSig !== undefined;
  if (!coinbase && invited) throw new Error("only a coinbase can have an inviter");
  w.u8(coinbase ? (invited ? 2 : 0) : 1);
  w.hexFixed(tx.id, 32);
  w.hexFixed(addrBytes(tx.to), 20);
  w.u64(tx.amount);
  w.u64(tx.fee);
  w.u64(tx.nonce);
  w.u64(tx.timestamp);
  if (coinbase && invited) {
    if (!tx.referrer || !tx.referrerKey || !tx.referrerSig) throw new Error("inviter needs address, key and signature");
    w.hexFixed(addrBytes(tx.referrer), 20);
    w.hexFixed(tx.referrerKey, 33);
    w.hexFixed(tx.referrerSig, 64);
  }
  if (coinbase) {
    if (tx.fromAddress !== null || tx.signature !== null) throw new Error("coinbase must not have a sender");
  } else {
    if (tx.fromAddress === null || tx.signature === null) throw new Error("transaction needs a sender and a signature");
    w.hexVar(tx.fromPublicKey as string, 1, PUBKEY_MAX);
    w.hexVar(tx.signature, 1, SIG_MAX);
  }
}

function readTx(r: Reader): Transaction {
  const kind = r.u8();
  if (kind !== 0 && kind !== 1 && kind !== 2) throw new Error("unknown transaction kind");
  const id = r.hexFixed(32);
  const to = addrFrom(r.hexFixed(20));
  const amount = r.u64();
  const fee = r.u64();
  const nonce = r.u64();
  const timestamp = r.u64();
  if (kind === 2) {
    const referrer = addrFrom(r.hexFixed(20));
    const referrerKey = r.hexFixed(33);
    const referrerSig = r.hexFixed(64);
    return { id, fromPublicKey: null, fromAddress: null, to, amount, fee, nonce, timestamp, signature: null, referrer, referrerKey, referrerSig };
  }
  if (kind === 0) return { id, fromPublicKey: null, fromAddress: null, to, amount, fee, nonce, timestamp, signature: null };
  const pk = r.hexVar(1, PUBKEY_MAX);
  const sig = r.hexVar(1, SIG_MAX);
  return { id, fromPublicKey: pk, fromAddress: null as unknown as string, to, amount, fee, nonce, timestamp, signature: sig };
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  const w = new Writer();
  writeTx(w, tx);
  return w.bytes();
}

export function decodeTransaction(bytes: Uint8Array, addressOf: (publicKeyHex: string) => string): Transaction {
  const r = new Reader(bytes);
  const tx = readTx(r);
  r.end();
  if (tx.fromPublicKey !== null) tx.fromAddress = addressOf(tx.fromPublicKey);
  return tx;
}

export function encodeBlock(b: Block): Uint8Array {
  if (b.transactions.length > MAX_TX_PER_BLOCK) throw new Error("too many transactions");
  const w = new Writer();
  w.u32(b.index);
  w.u64(b.timestamp);
  w.hexFixed(b.previousHash, 32);
  w.u16(b.difficulty);
  w.hexFixed(b.hash, 32);
  if (b.seed !== "" && b.seed.length !== SEED_BYTES * 2) throw new Error("seed has the wrong length");
  w.hexVar(b.seed, 0, SEED_BYTES);
  if (b.proofAddress === "") w.u8(0);
  else {
    w.u8(20);
    w.hexFixed(addrBytes(b.proofAddress), 20);
  }
  w.hexFixed(b.nonce, 8);
  w.u16(b.transactions.length);
  for (const tx of b.transactions) writeTx(w, tx);
  return w.bytes();
}

export function decodeBlock(bytes: Uint8Array, addressOf: (publicKeyHex: string) => string): Block {
  const r = new Reader(bytes);
  const index = r.u32();
  const timestamp = r.u64();
  const previousHash = r.hexFixed(32);
  const difficulty = r.u16();
  const hash = r.hexFixed(32);
  const seed = r.hexVar(0, SEED_BYTES);
  if (seed !== "" && seed.length !== SEED_BYTES * 2) throw new Error("seed has the wrong length");
  const al = r.u8();
  if (al !== 0 && al !== 20) throw new Error("invalid address length");
  const proofAddress = al === 0 ? "" : addrFrom(r.hexFixed(20));
  const nonce = r.hexFixed(8);
  const n = r.u16();
  const transactions: Transaction[] = [];
  for (let i = 0; i < n; i++) {
    const tx = readTx(r);
    if (tx.fromPublicKey !== null) tx.fromAddress = addressOf(tx.fromPublicKey);
    transactions.push(tx);
  }
  r.end();
  return { index, timestamp, transactions, previousHash, nonce, difficulty, hash, seed, proofAddress };
}
