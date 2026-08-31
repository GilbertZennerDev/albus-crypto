import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { addressFromPublicKey, sign, verify } from "./wallet.js";

export interface Transaction {
  id: string;
  fromPublicKey: string | null;
  fromAddress: string | null;
  to: string;
  amount: number;
  timestamp: number;
  signature: string | null;
  /** Fee owed by the sender, computed server-side at submission time (not part of the signed payload). */
  fee?: number;
  /** Marks a coinbase tx as redistributed transaction fees rather than newly minted block subsidy, so supply accounting doesn't double-count it as "mined". */
  isFeeReward?: boolean;
}

export function hashTransactionFields(
  fromPublicKey: string | null,
  to: string,
  amount: number,
  timestamp: number,
): string {
  const payload = `${fromPublicKey ?? "coinbase"}|${to}|${amount}|${timestamp}`;
  return bytesToHex(sha256(utf8ToBytes(payload)));
}

export function createCoinbaseTransaction(to: string, amount: number, isFeeReward = false): Transaction {
  const timestamp = Date.now();
  const id = hashTransactionFields(null, to, amount, timestamp);
  return { id, fromPublicKey: null, fromAddress: null, to, amount, timestamp, signature: null, isFeeReward };
}

export function createTransaction(
  privateKeyHex: string,
  publicKeyHex: string,
  to: string,
  amount: number,
): Transaction {
  const timestamp = Date.now();
  const id = hashTransactionFields(publicKeyHex, to, amount, timestamp);
  const signature = sign(id, privateKeyHex);
  return {
    id,
    fromPublicKey: publicKeyHex,
    fromAddress: addressFromPublicKey(publicKeyHex),
    to,
    amount,
    timestamp,
    signature,
  };
}

const ADDRESS_RE = /^albus1[0-9a-f]{40}$/;

export function isTransactionWellFormed(tx: Transaction): boolean {
  if (typeof tx.to !== "string" || !ADDRESS_RE.test(tx.to)) return false;
  if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount) || tx.amount <= 0) return false;
  if (typeof tx.timestamp !== "number") return false;
  return true;
}

export function verifyTransactionSignature(tx: Transaction): boolean {
  if (!tx.fromPublicKey) return false;
  if (!tx.signature) return false;
  const expectedId = hashTransactionFields(tx.fromPublicKey, tx.to, tx.amount, tx.timestamp);
  if (expectedId !== tx.id) return false;
  if (addressFromPublicKey(tx.fromPublicKey) !== tx.fromAddress) return false;
  return verify(tx.id, tx.signature, tx.fromPublicKey);
}
