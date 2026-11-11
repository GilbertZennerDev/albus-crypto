// CUDA kernels for the Albus hash contract (see common/sha256.h).
//
// Ruleset 4: hash = sha256( inner(32) || nonce8 ), where inner = sha256(seed || address) is fixed per job.
// One SHA-256 block per attempt: w[0..7] = inner, w[8] = nonce high word, w[9] = nonce low word,
// w[10] = 0x80000000, w[11..14] = 0, w[15] = 320 bits. Rounds 0..8 only see job-constant words, so the
// host runs them once (job.pre). A thread writes its 32-bit `lo` into w[9], runs rounds 9..63 fully
// unrolled with a 16-word in-register circular schedule and tests digest words 0/1 (a and b after
// round 63) against the share/block masks.
#pragma once
#include <cstdint>
#include <cuda_runtime.h>

namespace albus_gpu {

constexpr int SHARE_CAP = 512;
constexpr int BLOCK_CAP = 64;
constexpr int PRE_ROUNDS = 9;  // rounds that consume only job-constant words (w[0..8])

struct ResultBuf {
  uint32_t shareCount;
  uint32_t blockCount;
  uint32_t shareLo[SHARE_CAP];
  uint32_t blockLo[BLOCK_CAP];
};

struct GpuJob {
  uint32_t w[9];     // inner digest words and the nonce high word (w[8])
  uint32_t pre[8];   // working variables after the first PRE_ROUNDS rounds
  uint32_t mid[8];   // initial state (SHA-256 IV)
  uint32_t m0s, m1s; // share masks on digest words 0 and 1
  uint32_t m0b, m1b; // block masks
};

__constant__ uint32_t d_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

__device__ __forceinline__ uint32_t rotr(uint32_t x, int n) { return __funnelshift_r(x, x, n); }
__device__ __forceinline__ uint32_t bsig0(uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
__device__ __forceinline__ uint32_t bsig1(uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
__device__ __forceinline__ uint32_t ssig0(uint32_t x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
__device__ __forceinline__ uint32_t ssig1(uint32_t x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }
__device__ __forceinline__ uint32_t ch(uint32_t e, uint32_t f, uint32_t g) { return (e & f) ^ (~e & g); }
__device__ __forceinline__ uint32_t maj(uint32_t a, uint32_t b, uint32_t c) { return (a & b) ^ (a & c) ^ (b & c); }

__global__ void __launch_bounds__(512)
mine_kernel(const GpuJob job, uint32_t loStart, uint32_t loops, uint32_t stride, ResultBuf* res) {
  const uint32_t idx = blockIdx.x * blockDim.x + threadIdx.x;

  for (uint32_t it = 0; it < loops; ++it) {
    const uint32_t lo = loStart + it * stride + idx;

    uint32_t w[16];
#pragma unroll
    for (int j = 0; j < 9; j++) w[j] = job.w[j];
    w[9] = lo;
    w[10] = 0x80000000u;
    w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0;
    w[15] = 320u;

    uint32_t a = job.pre[0], b = job.pre[1], c = job.pre[2], d = job.pre[3];
    uint32_t e = job.pre[4], f = job.pre[5], g = job.pre[6], h = job.pre[7];
#pragma unroll
    for (int t = PRE_ROUNDS; t < 64; t++) {
      uint32_t wt;
      if (t < 16) {
        wt = w[t];
      } else {
        wt = ssig1(w[(t - 2) & 15]) + w[(t - 7) & 15] + ssig0(w[(t - 15) & 15]) + w[t & 15];
        w[t & 15] = wt;
      }
      const uint32_t t1 = h + bsig1(e) + ch(e, f, g) + d_K[t] + wt;
      const uint32_t t2 = bsig0(a) + maj(a, b, c);
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    // After round 63: a = A63, b = A62. Digest words 0 and 1.
    const uint32_t h0 = a + job.mid[0];
    const uint32_t h1 = b + job.mid[1];
    if (((h0 & job.m0s) | (h1 & job.m1s)) == 0) {
      if (((h0 & job.m0b) | (h1 & job.m1b)) == 0) {
        uint32_t s = atomicAdd(&res->blockCount, 1u);
        if (s < BLOCK_CAP) res->blockLo[s] = lo;
      } else {
        uint32_t s = atomicAdd(&res->shareCount, 1u);
        if (s < SHARE_CAP) res->shareLo[s] = lo;
      }
    }
  }
}

// ---- diagnostic build: full digest of one nonce (used by tests and the startup self-test)
__global__ void digest_kernel(const uint32_t* inner, uint64_t nonce, uint32_t* out8) {
  uint32_t w[16];
  for (int j = 0; j < 8; j++) w[j] = inner[j];
  w[8] = (uint32_t)(nonce >> 32);
  w[9] = (uint32_t)nonce;
  w[10] = 0x80000000u;
  for (int j = 11; j < 15; j++) w[j] = 0;
  w[15] = 320u;
  const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint32_t a = iv[0], b = iv[1], c = iv[2], d = iv[3], e = iv[4], f = iv[5], g = iv[6], h = iv[7];
  for (int t = 0; t < 64; t++) {
    uint32_t wt;
    if (t < 16) {
      wt = w[t];
    } else {
      wt = ssig1(w[(t - 2) & 15]) + w[(t - 7) & 15] + ssig0(w[(t - 15) & 15]) + w[t & 15];
      w[t & 15] = wt;
    }
    const uint32_t t1 = h + bsig1(e) + ch(e, f, g) + d_K[t] + wt;
    const uint32_t t2 = bsig0(a) + maj(a, b, c);
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  out8[0] = a + iv[0]; out8[1] = b + iv[1]; out8[2] = c + iv[2]; out8[3] = d + iv[3];
  out8[4] = e + iv[4]; out8[5] = f + iv[5]; out8[6] = g + iv[6]; out8[7] = h + iv[7];
}

}  // namespace albus_gpu
