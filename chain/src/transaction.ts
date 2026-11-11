import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { addressFromPublicKey, sign, verify } from "./wallet.js";
import { isUnits } from "./params.js";
import { addressBytes, concatBytes, hexFixedBytes, tagBytes, u32be, u64be } from "./bin.js";

export interface Transaction {
  id: string;
  fromPublicKey: string | null;
  fromAddress: string | null;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  timestamp: number;
  signature: string | null;
  referrer?: string;
  referrerKey?: string;
  referrerSig?: string;
}

export interface Invitation {
  referrer: string;
  key: string;
  sig: string;
}

const KEY_RE = /^[0-9a-f]{66}$/;
const SIG_RE = /^[0-9a-f]{128}$/;

function invitationMessage(networkId: string, to: string, referrer: string): string {
  return bytesToHex(sha256(concatBytes(tagBytes("albus-invite-v1"), tagBytes(networkId), addressBytes(to), addressBytes(referrer))));
}

export function createInvitation(privateKeyHex: string, publicKeyHex: string, referrer: string, networkId: string): Invitation {
  return { referrer, key: publicKeyHex, sig: sign(invitationMessage(networkId, addressFromPublicKey(publicKeyHex), referrer), privateKeyHex) };
}

export function verifyInvitation(inv: Invitation, to: string, networkId: string): boolean {
  if (!inv || typeof inv.referrer !== "string" || typeof inv.key !== "string" || typeof inv.sig !== "string") return false;
  if (!ADDRESS_RE.test(inv.referrer) || inv.referrer === to || !KEY_RE.test(inv.key) || !SIG_RE.test(inv.sig)) return false;
  if (addressFromPublicKey(inv.key) !== to) return false;
  return verify(invitationMessage(networkId, to, inv.referrer), inv.sig, inv.key);
}

export const encodeInvitation = (i: Invitation): string => `${i.referrer}:${i.key}:${i.sig}`;

export function parseInvitation(text: string | undefined): Invitation | null {
  const m = /^(albus1[0-9a-f]{40}):([0-9a-f]{66}):([0-9a-f]{128})$/.exec(text ?? "");
  return m ? { referrer: m[1], key: m[2], sig: m[3] } : null;
}

export const ADDRESS_RE = /^albus1[0-9a-f]{40}$/;
const HEX_RE = /^[0-9a-f]+$/;

export function hashTransactionFields(
  networkId: string,
  fromPublicKey: string | null,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
  timestamp: number,
): string {
  const pk = fromPublicKey === null ? new Uint8Array(0) : hexToBytes(fromPublicKey);
  if (pk.length > 65) throw new Error("key too long");
  return bytesToHex(
    sha256(
      concatBytes(
        tagBytes("albus-tx-v4"),
        hexFixedBytes(networkId, 8),
        Uint8Array.of(pk.length),
        pk,
        addressBytes(to),
        u64be(amount),
        u64be(fee),
        u64be(nonce),
        u64be(timestamp),
      ),
    ),
  );
}

export function coinbaseId(to: string, units: number, height: number, inv?: Invitation): string {
  if (inv) return bytesToHex(sha256(concatBytes(tagBytes("albus-cb-v5-ref"), addressBytes(to), addressBytes(inv.referrer), hexFixedBytes(inv.key, 33), hexFixedBytes(inv.sig, 64), u64be(units), u32be(height))));
  return bytesToHex(sha256(concatBytes(tagBytes("albus-cb-v4"), addressBytes(to), u64be(units), u32be(height))));
}

export function createCoinbaseTransaction(to: string, units: number, height: number, timestamp: number, inv?: Invitation): Transaction {
  return {
    id: coinbaseId(to, units, height, inv),
    fromPublicKey: null,
    fromAddress: null,
    to,
    amount: units,
    fee: 0,
    nonce: 0,
    timestamp,
    signature: null,
    ...(inv ? { referrer: inv.referrer, referrerKey: inv.key, referrerSig: inv.sig } : {}),
  };
}

export function createTransaction(
  privateKeyHex: string,
  publicKeyHex: string,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
  networkId: string,
  timestamp = Date.now(),
): Transaction {
  const id = hashTransactionFields(networkId, publicKeyHex, to, amount, fee, nonce, timestamp);
  return {
    id,
    fromPublicKey: publicKeyHex,
    fromAddress: addressFromPublicKey(publicKeyHex),
    to,
    amount,
    fee,
    nonce,
    timestamp,
    signature: sign(id, privateKeyHex),
  };
}

export function isTransactionWellFormed(tx: Transaction): boolean {
  if (!tx || typeof tx !== "object") return false;
  if (typeof tx.id !== "string" || tx.id.length !== 64 || !HEX_RE.test(tx.id)) return false;
  if (typeof tx.to !== "string" || !ADDRESS_RE.test(tx.to)) return false;
  if (!isUnits(tx.amount) || !isUnits(tx.fee)) return false;
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) return false;
  if (!Number.isSafeInteger(tx.timestamp) || tx.timestamp < 0) return false;
  if (typeof tx.fromPublicKey !== "string" || !HEX_RE.test(tx.fromPublicKey) || tx.fromPublicKey.length > 130) return false;
  if (typeof tx.fromAddress !== "string" || !ADDRESS_RE.test(tx.fromAddress)) return false;
  if (typeof tx.signature !== "string" || !HEX_RE.test(tx.signature) || tx.signature.length > 140) return false;
  return true;
}

export function verifyTransactionSignature(tx: Transaction, networkId: string): boolean {
  if (!tx.fromPublicKey || !tx.signature) return false;
  if (hashTransactionFields(networkId, tx.fromPublicKey, tx.to, tx.amount, tx.fee, tx.nonce, tx.timestamp) !== tx.id) return false;
  if (addressFromPublicKey(tx.fromPublicKey) !== tx.fromAddress) return false;
  return verify(tx.id, tx.signature, tx.fromPublicKey);
}

export function normalizeTransaction(raw: any): Transaction | null {
  if (!raw || typeof raw !== "object") return null;
  const tx: Transaction = {
    id: raw.id,
    fromPublicKey: raw.fromPublicKey,
    fromAddress: raw.fromAddress,
    to: raw.to,
    amount: raw.amount,
    fee: raw.fee,
    nonce: raw.nonce,
    timestamp: raw.timestamp,
    signature: raw.signature,
  };
  return isTransactionWellFormed(tx) ? tx : null;
}
