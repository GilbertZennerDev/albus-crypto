import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  address: string;
}

export function addressFromPublicKey(publicKeyHex: string): string {
  const hash = sha256(sha256(hexToBytes(publicKeyHex)));
  return "albus1" + bytesToHex(hash).slice(0, 40);
}

export function generateKeyPair(): KeyPair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const publicKeyHex = bytesToHex(publicKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: publicKeyHex,
    address: addressFromPublicKey(publicKeyHex),
  };
}

export function keyPairFromPrivateKey(privateKeyHex: string): KeyPair {
  const publicKey = secp256k1.getPublicKey(hexToBytes(privateKeyHex), true);
  const publicKeyHex = bytesToHex(publicKey);
  return { privateKey: privateKeyHex, publicKey: publicKeyHex, address: addressFromPublicKey(publicKeyHex) };
}

function sign(messageHex: string, privateKeyHex: string): string {
  const sig = secp256k1.sign(hexToBytes(messageHex), hexToBytes(privateKeyHex));
  return sig.toCompactHex();
}

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
}

export const UNITS_PER_COIN = 100_000_000;

export function parseCoins(text: string): number | null {
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) return null;
  const u = Number(m[1]) * UNITS_PER_COIN + Number((m[2] ?? "").padEnd(8, "0"));
  return Number.isSafeInteger(u) && u > 0 ? u : null;
}

export function formatUnits(units: number): string {
  const whole = Math.floor(units / UNITS_PER_COIN);
  const frac = String(units % UNITS_PER_COIN).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function hashTransactionFields(
  networkId: string,
  fromPublicKey: string | null,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
  timestamp: number,
): string {
  const pk = fromPublicKey === null ? new Uint8Array(0) : hexToBytes(fromPublicKey);
  const u64 = (n: number): Uint8Array => {
    const out = new Uint8Array(8);
    let v = BigInt(n);
    for (let i = 7; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  };
  return bytesToHex(
    sha256(
      concatBytes(
        utf8ToBytes("albus-tx-v4"),
        hexToBytes(networkId),
        Uint8Array.of(pk.length),
        pk,
        hexToBytes(to.slice(6)),
        u64(amount),
        u64(fee),
        u64(nonce),
        u64(timestamp),
      ),
    ),
  );
}

export function createSignedTransaction(
  keyPair: KeyPair,
  to: string,
  amount: number,
  fee: number,
  nonce: number,
  networkId: string,
): Transaction {
  const timestamp = Date.now();
  const id = hashTransactionFields(networkId, keyPair.publicKey, to, amount, fee, nonce, timestamp);
  const signature = sign(id, keyPair.privateKey);
  return {
    id,
    fromPublicKey: keyPair.publicKey,
    fromAddress: keyPair.address,
    to,
    amount,
    fee,
    nonce,
    timestamp,
    signature,
  };
}
