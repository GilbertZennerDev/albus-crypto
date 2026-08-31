// SHA-256 mining kernel. Mirrors sha256-reference.js's sha256Compress exactly
// (that file is validated against Node's crypto — this is a direct
// translation of the same arithmetic, not an independent implementation).
//
// Each invocation finishes ONE 64-byte block (the job's fixed prefix's last
// 16 bytes + this thread's 16-char zero-padded nonce hex + SHA-256 padding)
// starting from a precomputed midstate (the state after compressing the
// prefix's first 64 bytes, computed once per job on the CPU). Since the
// nonce is kept within 32 bits, the top 8 hex characters of the (16-char)
// nonce string are always "00000000" — baked in as a constant instead of
// computed per-thread.
export const MAX_FOUND_PER_DISPATCH = 256;

export const SHA256_MINER_WGSL = `
struct Params {
  h0123: vec4<u32>,
  h4567: vec4<u32>,
  tail: vec4<u32>,
  base_nonce: u32,
  difficulty_nibbles: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> found_count: atomic<u32>;
@group(0) @binding(2) var<storage, read_write> found_nonces: array<u32, ${MAX_FOUND_PER_DISPATCH}>;

const K: array<u32, 64> = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
);

fn rotr(x: u32, n: u32) -> u32 {
  return (x >> n) | (x << (32u - n));
}

fn hex_ascii(nibble: u32) -> u32 {
  if (nibble < 10u) {
    return 0x30u + nibble;
  }
  return 0x61u + (nibble - 10u);
}

// Counts leading zero hex nibbles across the 8-word digest (H0 is most significant).
fn leading_zero_nibbles(h: array<u32, 8>) -> u32 {
  var total = 0u;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let word = h[i];
    if (word == 0u) {
      total = total + 8u;
    } else {
      total = total + (countLeadingZeros(word) / 4u);
      break;
    }
  }
  return total;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nonce = params.base_nonce + gid.x;

  // Low 32 bits of the 16-char zero-padded nonce hex string, as 2 big-endian
  // ASCII words (4 chars each) — the high 8 chars are always "00000000".
  var n_ascii: array<u32, 8>;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let shift = (7u - i) * 4u;
    n_ascii[i] = hex_ascii((nonce >> shift) & 0xFu);
  }
  let nonce_word0 = (n_ascii[0] << 24u) | (n_ascii[1] << 16u) | (n_ascii[2] << 8u) | n_ascii[3];
  let nonce_word1 = (n_ascii[4] << 24u) | (n_ascii[5] << 16u) | (n_ascii[6] << 8u) | n_ascii[7];

  var w: array<u32, 64>;
  w[0] = params.tail.x;
  w[1] = params.tail.y;
  w[2] = params.tail.z;
  w[3] = params.tail.w;
  w[4] = 0x30303030u; // "0000" — high half of the nonce hex, always zero
  w[5] = 0x30303030u; // "0000"
  w[6] = nonce_word0;
  w[7] = nonce_word1;
  w[8] = 0x80000000u; // message end marker
  w[9] = 0u; w[10] = 0u; w[11] = 0u; w[12] = 0u; w[13] = 0u;
  w[14] = 0u;
  w[15] = 768u; // bit length of the full 96-byte message (seed|address|nonce), big-endian low word

  for (var i = 16u; i < 64u; i = i + 1u) {
    let s0 = rotr(w[i - 15u], 7u) ^ rotr(w[i - 15u], 18u) ^ (w[i - 15u] >> 3u);
    let s1 = rotr(w[i - 2u], 17u) ^ rotr(w[i - 2u], 19u) ^ (w[i - 2u] >> 10u);
    w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
  }

  var a = params.h0123.x; var b = params.h0123.y; var c = params.h0123.z; var d = params.h0123.w;
  var e = params.h4567.x; var f = params.h4567.y; var g = params.h4567.z; var h = params.h4567.w;

  for (var i = 0u; i < 64u; i = i + 1u) {
    let S1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
    let ch = (e & f) ^ ((~e) & g);
    let temp1 = h + S1 + ch + K[i] + w[i];
    let S0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let temp2 = S0 + maj;
    h = g; g = f; f = e; e = d + temp1;
    d = c; c = b; b = a; a = temp1 + temp2;
  }

  var digest: array<u32, 8>;
  digest[0] = params.h0123.x + a;
  digest[1] = params.h0123.y + b;
  digest[2] = params.h0123.z + c;
  digest[3] = params.h0123.w + d;
  digest[4] = params.h4567.x + e;
  digest[5] = params.h4567.y + f;
  digest[6] = params.h4567.z + g;
  digest[7] = params.h4567.w + h;

  if (leading_zero_nibbles(digest) >= params.difficulty_nibbles) {
    let idx = atomicAdd(&found_count, 1u);
    if (idx < ${MAX_FOUND_PER_DISPATCH}u) {
      found_nonces[idx] = nonce;
    }
  }
}
`;
