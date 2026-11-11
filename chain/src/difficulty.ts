export const SUB = 16;
export const HEX_STEPS = 4 * SUB;

function iroot(n: bigint, k: number): bigint {
  const kk = BigInt(k);
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  for (;;) {
    const y = ((kk - 1n) * x + n / x ** (kk - 1n)) / kk;
    if (y >= x) return x;
    x = y;
  }
}

const FRAC: bigint[] = Array.from({ length: SUB }, (_, k) => iroot(1n << BigInt(256 * SUB - k), SUB));

const MAX_HASH = 1n << 256n;

export function targetOf(difficulty: number): bigint {
  const bits = Math.floor(difficulty / SUB);
  return FRAC[difficulty % SUB] >> BigInt(bits);
}

export function hashBelowTarget(hashHex: string, difficulty: number): boolean {
  return BigInt("0x" + hashHex) < targetOf(difficulty);
}

export function workOf(difficulty: number): bigint {
  return MAX_HASH / targetOf(difficulty);
}

export function hexZerosFloor(difficulty: number): number {
  return Math.max(1, Math.min(16, Math.floor(difficulty / HEX_STEPS)));
}
