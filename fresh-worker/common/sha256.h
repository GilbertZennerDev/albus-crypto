#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <immintrin.h>
#if defined(_MSC_VER)
#include <intrin.h>
#elif defined(__GNUC__) && (defined(__x86_64__) || defined(__i386__))
#include <cpuid.h>
#endif

namespace albus {

alignas(64) static const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static const uint32_t SHA256_IV[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

inline uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

inline void compress_portable(uint32_t state[8], const uint8_t* p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = (uint32_t(p[4 * i]) << 24) | (uint32_t(p[4 * i + 1]) << 16) | (uint32_t(p[4 * i + 2]) << 8) | p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = h + S1 + ch + K256[i] + w[i];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + mj;
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  state[0] += a; state[1] += b; state[2] += c; state[3] += d;
  state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

inline void sha256_full(const uint8_t* msg, size_t len, uint8_t out[32]) {
  uint32_t st[8];
  memcpy(st, SHA256_IV, sizeof st);
  size_t i = 0;
  for (; i + 64 <= len; i += 64) compress_portable(st, msg + i);
  uint8_t tail[128] = {0};
  size_t rem = len - i;
  memcpy(tail, msg + i, rem);
  tail[rem] = 0x80;
  size_t total = (rem + 9 <= 64) ? 64 : 128;
  uint64_t bits = uint64_t(len) * 8;
  for (int k = 0; k < 8; k++) tail[total - 1 - k] = uint8_t(bits >> (8 * k));
  compress_portable(st, tail);
  if (total == 128) compress_portable(st, tail + 64);
  for (int k = 0; k < 8; k++) {
    out[4 * k] = uint8_t(st[k] >> 24); out[4 * k + 1] = uint8_t(st[k] >> 16);
    out[4 * k + 2] = uint8_t(st[k] >> 8); out[4 * k + 3] = uint8_t(st[k]);
  }
}

inline std::string to_hex(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s(n * 2, '0');
  for (size_t i = 0; i < n; i++) { s[2 * i] = d[p[i] >> 4]; s[2 * i + 1] = d[p[i] & 15]; }
  return s;
}

struct CpuFeatures {
  bool shani = false, avx2 = false;
};
inline CpuFeatures detect_cpu() {
  CpuFeatures f;
#if defined(_MSC_VER)
  int r[4];
  __cpuid(r, 0);
  int maxLeaf = r[0];
  if (maxLeaf >= 7) {
    __cpuidex(r, 7, 0);
    f.avx2 = (r[1] >> 5) & 1;
    f.shani = (r[1] >> 29) & 1;
    __cpuid(r, 1);
    bool osxsave = (r[2] >> 27) & 1;
    if (!osxsave || (_xgetbv(0) & 6) != 6) f.avx2 = false;
  }
#elif defined(__GNUC__) && (defined(__x86_64__) || defined(__i386__))
  unsigned a, b, c, d;
  if (__get_cpuid_max(0, nullptr) >= 7) {
    __cpuid_count(7, 0, a, b, c, d);
    f.avx2 = (b >> 5) & 1;
    f.shani = (b >> 29) & 1;
    __cpuid(1, a, b, c, d);
    bool osxsave = (c >> 27) & 1;
    unsigned xlo = 0, xhi = 0;
    if (osxsave) __asm__ volatile("xgetbv" : "=a"(xlo), "=d"(xhi) : "c"(0));
    if (!osxsave || (xlo & 6) != 6) f.avx2 = false;
  }
#endif
  return f;
}

#if defined(__clang__) || defined(__GNUC__)
#define ALBUS_TARGET_SHANI __attribute__((target("sha,sse4.1,ssse3")))
#define ALBUS_TARGET_AVX2 __attribute__((target("avx2")))
#else
#define ALBUS_TARGET_SHANI
#define ALBUS_TARGET_AVX2
#endif

struct ShaNiMid {
  __m128i abef, cdgh;
};

inline ALBUS_TARGET_SHANI ShaNiMid shani_load_state(const uint32_t st[8]) {
  __m128i tmp = _mm_loadu_si128((const __m128i*)&st[0]);
  __m128i s1 = _mm_loadu_si128((const __m128i*)&st[4]);
  tmp = _mm_shuffle_epi32(tmp, 0xB1);
  s1 = _mm_shuffle_epi32(s1, 0x1B);
  ShaNiMid m;
  m.abef = _mm_alignr_epi8(tmp, s1, 8);
  m.cdgh = _mm_blend_epi16(s1, tmp, 0xF0);
  return m;
}


template <int I>
ALBUS_TARGET_SHANI inline void shani_step(__m128i M[4], __m128i& s0, __m128i& s1) {
  __m128i cur;
  if constexpr (I < 4) {
    cur = M[I];
  } else {
    __m128i m0 = M[I & 3], m1 = M[(I + 1) & 3], m2 = M[(I + 2) & 3], m3 = M[(I + 3) & 3];
    m0 = _mm_sha256msg1_epu32(m0, m1);
    m0 = _mm_add_epi32(m0, _mm_alignr_epi8(m3, m2, 4));
    m0 = _mm_sha256msg2_epu32(m0, m3);
    M[I & 3] = m0;
    cur = m0;
  }
  __m128i msg = _mm_add_epi32(cur, _mm_load_si128((const __m128i*)&K256[4 * I]));
  s1 = _mm_sha256rnds2_epu32(s1, s0, msg);
  msg = _mm_shuffle_epi32(msg, 0x0E);
  s0 = _mm_sha256rnds2_epu32(s0, s1, msg);
}

ALBUS_TARGET_SHANI inline void shani_block_w01(const ShaNiMid& mid, const uint8_t* block, uint32_t& h0, uint32_t& h1) {
  const __m128i MASK = _mm_set_epi64x(0x0c0d0e0f08090a0bULL, 0x0405060700010203ULL);
  __m128i M[4];
  for (int i = 0; i < 4; i++) M[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i*)(block + 16 * i)), MASK);
  __m128i s0 = mid.abef, s1 = mid.cdgh;
  shani_step<0>(M, s0, s1); shani_step<1>(M, s0, s1); shani_step<2>(M, s0, s1); shani_step<3>(M, s0, s1);
  shani_step<4>(M, s0, s1); shani_step<5>(M, s0, s1); shani_step<6>(M, s0, s1); shani_step<7>(M, s0, s1);
  shani_step<8>(M, s0, s1); shani_step<9>(M, s0, s1); shani_step<10>(M, s0, s1); shani_step<11>(M, s0, s1);
  shani_step<12>(M, s0, s1); shani_step<13>(M, s0, s1); shani_step<14>(M, s0, s1); shani_step<15>(M, s0, s1);
  s0 = _mm_add_epi32(s0, mid.abef);
  h0 = (uint32_t)_mm_extract_epi32(s0, 3);
  h1 = (uint32_t)_mm_extract_epi32(s0, 2);
}

#define ALBUS_ROTR8(x, n) _mm256_or_si256(_mm256_srli_epi32((x), (n)), _mm256_slli_epi32((x), 32 - (n)))

ALBUS_TARGET_AVX2 inline void avx2_block8_w01(const uint32_t mid[8], __m256i w[16], uint32_t h0[8], uint32_t h1[8]) {
  __m256i a = _mm256_set1_epi32((int)mid[0]), b = _mm256_set1_epi32((int)mid[1]), c = _mm256_set1_epi32((int)mid[2]),
          d = _mm256_set1_epi32((int)mid[3]), e = _mm256_set1_epi32((int)mid[4]), f = _mm256_set1_epi32((int)mid[5]),
          g = _mm256_set1_epi32((int)mid[6]), h = _mm256_set1_epi32((int)mid[7]);
  __m256i prevA = a;
  for (int t = 0; t < 64; t++) {
    __m256i wt;
    if (t < 16) {
      wt = w[t];
    } else {
      __m256i w15 = w[(t - 15) & 15], w2 = w[(t - 2) & 15];
      __m256i s0 = _mm256_xor_si256(_mm256_xor_si256(ALBUS_ROTR8(w15, 7), ALBUS_ROTR8(w15, 18)), _mm256_srli_epi32(w15, 3));
      __m256i s1 = _mm256_xor_si256(_mm256_xor_si256(ALBUS_ROTR8(w2, 17), ALBUS_ROTR8(w2, 19)), _mm256_srli_epi32(w2, 10));
      wt = _mm256_add_epi32(_mm256_add_epi32(w[t & 15], s0), _mm256_add_epi32(w[(t - 7) & 15], s1));
      w[t & 15] = wt;
    }
    __m256i S1 = _mm256_xor_si256(_mm256_xor_si256(ALBUS_ROTR8(e, 6), ALBUS_ROTR8(e, 11)), ALBUS_ROTR8(e, 25));
    __m256i ch = _mm256_xor_si256(_mm256_and_si256(e, f), _mm256_andnot_si256(e, g));
    __m256i t1 = _mm256_add_epi32(_mm256_add_epi32(h, S1), _mm256_add_epi32(_mm256_add_epi32(ch, _mm256_set1_epi32((int)K256[t])), wt));
    __m256i S0 = _mm256_xor_si256(_mm256_xor_si256(ALBUS_ROTR8(a, 2), ALBUS_ROTR8(a, 13)), ALBUS_ROTR8(a, 22));
    __m256i mj = _mm256_xor_si256(_mm256_xor_si256(_mm256_and_si256(a, b), _mm256_and_si256(a, c)), _mm256_and_si256(b, c));
    __m256i t2 = _mm256_add_epi32(S0, mj);
    prevA = a;
    h = g; g = f; f = e; e = _mm256_add_epi32(d, t1); d = c; c = b; b = a; a = _mm256_add_epi32(t1, t2);
  }
  __m256i r0 = _mm256_add_epi32(a, _mm256_set1_epi32((int)mid[0]));
  __m256i r1 = _mm256_add_epi32(prevA, _mm256_set1_epi32((int)mid[1]));
  _mm256_storeu_si256((__m256i*)h0, r0);
  _mm256_storeu_si256((__m256i*)h1, r1);
}

constexpr size_t NONCE_HEX_LEN = 16;

struct JobPrefix {
  uint32_t mid[8];
  uint32_t inner[8];
};

inline bool is_hex_lower(const std::string& s) {
  for (char c : s)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

inline int hex_val(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }

inline bool prepare_job(const std::string& seed, const std::string& address, JobPrefix& out) {
  if (seed.size() != 64 || !is_hex_lower(seed) || address.size() != 46 || address.compare(0, 6, "albus1") != 0 ||
      !is_hex_lower(address.substr(6)))
    return false;
  uint8_t msg[52];
  for (int i = 0; i < 32; i++) msg[i] = uint8_t(hex_val(seed[2 * i]) * 16 + hex_val(seed[2 * i + 1]));
  for (int i = 0; i < 20; i++) msg[32 + i] = uint8_t(hex_val(address[6 + 2 * i]) * 16 + hex_val(address[7 + 2 * i]));
  uint8_t dig[32];
  sha256_full(msg, 52, dig);
  memcpy(out.mid, SHA256_IV, sizeof out.mid);
  for (int k = 0; k < 8; k++)
    out.inner[k] = (uint32_t(dig[4 * k]) << 24) | (uint32_t(dig[4 * k + 1]) << 16) | (uint32_t(dig[4 * k + 2]) << 8) | dig[4 * k + 3];
  return true;
}

inline void build_block2(const JobPrefix& job, uint64_t nonce, uint8_t block[64]) {
  memset(block, 0, 64);
  for (int k = 0; k < 8; k++) {
    block[4 * k] = uint8_t(job.inner[k] >> 24); block[4 * k + 1] = uint8_t(job.inner[k] >> 16);
    block[4 * k + 2] = uint8_t(job.inner[k] >> 8); block[4 * k + 3] = uint8_t(job.inner[k]);
  }
  for (int k = 0; k < 8; k++) block[32 + k] = uint8_t(nonce >> (56 - 8 * k));
  block[40] = 0x80;
  const uint64_t bits = 40 * 8;
  for (int k = 0; k < 8; k++) block[63 - k] = uint8_t(bits >> (8 * k));
}

inline bool parse_nonce16(const std::string& s, uint64_t& n) {
  if (s.size() != NONCE_HEX_LEN || !is_hex_lower(s)) return false;
  n = 0;
  for (char c : s) n = (n << 4) | (uint64_t)hex_val(c);
  return true;
}

inline void reference_digest_n(const JobPrefix& job, uint64_t nonce, uint32_t out[8]) {
  uint8_t block[64];
  build_block2(job, nonce, block);
  memcpy(out, job.mid, 32);
  compress_portable(out, block);
}

inline bool reference_digest(const JobPrefix& job, const std::string& nonceHex, uint32_t out[8]) {
  uint64_t n;
  if (!parse_nonce16(nonceHex, n)) return false;
  reference_digest_n(job, n, out);
  return true;
}

struct Target {
  uint32_t m0 = 0, m1 = 0;
  bool met(uint32_t h0, uint32_t h1) const { return (h0 & m0) == 0 && (h1 & m1) == 0; }
};
inline Target make_target(int n) {
  Target t;
  if (n <= 0) return t;
  if (n > 16) n = 16;
  if (n <= 8) {
    t.m0 = 0xFFFFFFFFu << (32 - 4 * n);
    t.m1 = 0;
  } else {
    t.m0 = 0xFFFFFFFFu;
    t.m1 = 0xFFFFFFFFu << (32 - 4 * (n - 8));
  }
  return t;
}

inline const uint16_t* hex_pair_table() {
  static uint16_t tbl[256];
  static bool init = false;
  if (!init) {
    const char* d = "0123456789abcdef";
    for (int i = 0; i < 256; i++) tbl[i] = uint16_t(uint8_t(d[i >> 4]) | (uint16_t(uint8_t(d[i & 15])) << 8));
    init = true;
  }
  return tbl;
}

inline std::string nonce_to_hex(uint64_t n) {
  static const char* d = "0123456789abcdef";
  char buf[17];
  for (int i = 15; i >= 0; i--) { buf[i] = d[n & 15]; n >>= 4; }
  buf[16] = 0;
  return std::string(buf);
}

}
