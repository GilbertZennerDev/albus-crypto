import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export const u16be = (n: number): Uint8Array => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
export const u32be = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
export function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("u64 out of range");
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
export const tagBytes = (tag: string): Uint8Array => utf8ToBytes(tag);
export const hexFixedBytes = (hex: string, bytes: number): Uint8Array => {
  if (typeof hex !== "string" || hex.length !== bytes * 2 || !/^[0-9a-f]*$/.test(hex)) throw new Error("hex field has the wrong shape");
  return hexToBytes(hex);
};
export const addressBytes = (address: string): Uint8Array => {
  if (typeof address !== "string" || !/^albus1[0-9a-f]{40}$/.test(address)) throw new Error("invalid address");
  return hexToBytes(address.slice(6));
};
export { concatBytes };
