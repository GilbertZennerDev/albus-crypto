#pragma once
#include <cstdint>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
#include "sha256.h"

namespace albus {

enum class Path { ShaNi, Avx2, Portable };

inline const char* path_name(Path p) {
  switch (p) {
    case Path::ShaNi: return "sha-ni";
    case Path::Avx2: return "avx2";
    default: return "portable";
  }
}

inline Path best_path() {
  CpuFeatures f = detect_cpu();
  if (f.shani) return Path::ShaNi;
  if (f.avx2) return Path::Avx2;
  return Path::Portable;
}

struct Hit {
  uint64_t nonce;
  bool block;
};

inline void scan_generic(const JobPrefix& job, uint64_t n0, uint64_t count, Target share, Target block, std::vector<Hit>& hits) {
  for (uint64_t i = 0; i < count; i++) {
    uint64_t n = n0 + i;
    uint32_t d[8];
    reference_digest_n(job, n, d);
    if (share.met(d[0], d[1])) hits.push_back({n, block.met(d[0], d[1])});
  }
}

inline void bswap_words(const uint8_t blk[64], uint32_t w[16]) {
  for (int j = 0; j < 16; j++) {
    uint32_t v;
    memcpy(&v, blk + 4 * j, 4);
    w[j] = ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >> 8) & 0xFF00) | (v >> 24);
  }
}

inline void put_be32(uint8_t* dst, uint32_t v) {
  dst[0] = uint8_t(v >> 24); dst[1] = uint8_t(v >> 16); dst[2] = uint8_t(v >> 8); dst[3] = uint8_t(v);
}

inline void scan_fast(const JobPrefix& job, const ShaNiMid* mid, uint64_t n0, uint64_t count, Target share, Target block,
                      Path path, std::vector<Hit>& hits) {
  const uint32_t lo0 = (uint32_t)n0;
  uint8_t blk[64];
  build_block2(job, n0 & 0xFFFFFFFF00000000ULL, blk);

  uint64_t i = 0;
  if (path == Path::ShaNi) {
    for (; i < count; i++) {
      put_be32(blk + 36, lo0 + (uint32_t)i);
      uint32_t h0, h1;
      shani_block_w01(*mid, blk, h0, h1);
      if (share.met(h0, h1)) hits.push_back({n0 + i, block.met(h0, h1)});
    }
    return;
  }
  if (path == Path::Avx2) {
    uint32_t w0[16];
    bswap_words(blk, w0);
    for (; i + 8 <= count; i += 8) {
      alignas(32) uint32_t lanes[16][8];
      for (int j = 0; j < 16; j++)
        for (int l = 0; l < 8; l++) lanes[j][l] = w0[j];
      for (int l = 0; l < 8; l++) lanes[9][l] = lo0 + (uint32_t)(i + l);
      __m256i wv[16];
      for (int j = 0; j < 16; j++) wv[j] = _mm256_load_si256((const __m256i*)lanes[j]);
      alignas(32) uint32_t h0[8], h1[8];
      avx2_block8_w01(job.mid, wv, h0, h1);
      for (int l = 0; l < 8; l++)
        if (share.met(h0[l], h1[l])) hits.push_back({n0 + i + l, block.met(h0[l], h1[l])});
    }
  }
  for (; i < count; i++) {
    put_be32(blk + 36, lo0 + (uint32_t)i);
    uint32_t st[8];
    memcpy(st, job.mid, 32);
    compress_portable(st, blk);
    if (share.met(st[0], st[1])) hits.push_back({n0 + i, block.met(st[0], st[1])});
  }
}

inline void scan_range(const JobPrefix& job, const ShaNiMid* mid, uint64_t n0, uint64_t count, Target share, Target block,
                       Path path, std::vector<Hit>& hits) {
  while (count > 0) {
    uint64_t room = (1ULL << 32) - (n0 & 0xFFFFFFFFULL);
    uint64_t n = std::min<uint64_t>(count, room);
    scan_fast(job, mid, n0, n, share, block, path, hits);
    n0 += n; count -= n;
  }
}

}
