import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

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

export function sign(messageHex: string, privateKeyHex: string): string {
  const sig = secp256k1.sign(hexToBytes(messageHex), hexToBytes(privateKeyHex));
  return sig.toCompactHex();
}

export function verify(messageHex: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return secp256k1.verify(hexToBytes(signatureHex), hexToBytes(messageHex), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
