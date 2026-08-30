import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

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
  timestamp: number;
  signature: string | null;
}

function hashTransactionFields(
  fromPublicKey: string | null,
  to: string,
  amount: number,
  timestamp: number,
): string {
  const payload = `${fromPublicKey ?? "coinbase"}|${to}|${amount}|${timestamp}`;
  return bytesToHex(sha256(utf8ToBytes(payload)));
}

export function createSignedTransaction(
  keyPair: KeyPair,
  to: string,
  amount: number,
): Transaction {
  const timestamp = Date.now();
  const id = hashTransactionFields(keyPair.publicKey, to, amount, timestamp);
  const signature = sign(id, keyPair.privateKey);
  return {
    id,
    fromPublicKey: keyPair.publicKey,
    fromAddress: keyPair.address,
    to,
    amount,
    timestamp,
    signature,
  };
}
