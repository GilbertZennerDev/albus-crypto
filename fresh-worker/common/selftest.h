#pragma once
#include <string>
#include <vector>
#include "scan.h"
#include "sha256.h"

namespace albus {

inline bool nist_selftest(std::string& err) {
  struct V { const char* msg; const char* digest; };
  static const V vs[] = {
      {"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
      {"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
      {"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"},
  };
  for (const V& v : vs) {
    uint8_t d[32];
    sha256_full((const uint8_t*)v.msg, strlen(v.msg), d);
    if (to_hex(d, 32) != v.digest) { err = std::string("NIST vector failed for '") + v.msg + "'"; return false; }
  }
  return true;
}

struct KnownVector {
  const char* seed;
  const char* address;
  const char* nonce;
  const char* digest;
};
inline const KnownVector* known_vectors(size_t& n) {
  static const KnownVector kv[] = {
      {"0000000000000000000000000000000000000000000000000000000000000000", "albus10000000000000000000000000000000000000000",
       "0000000100000000", "b0f65953c61cdd569077bd556016e9cec384200cfe4eb78c6439322853019fb5"},
      {"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "albus1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "1234567890abcdef", "7b5553e98a12d22d36e4f7edd71aa8db096e4551f8fab13300a8cb4861e46178"},
  };
  n = sizeof(kv) / sizeof(kv[0]);
  return kv;
}

inline bool digest_words_to_hex(const uint32_t d[8], std::string& hex) {
  uint8_t b[32];
  for (int i = 0; i < 8; i++) { b[4 * i] = d[i] >> 24; b[4 * i + 1] = d[i] >> 16; b[4 * i + 2] = d[i] >> 8; b[4 * i + 3] = d[i]; }
  hex = to_hex(b, 32);
  return true;
}

inline bool cpu_selftest(Path path, std::string& err) {
  if (!nist_selftest(err)) return false;
  {
    size_t n;
    const KnownVector* kv = known_vectors(n);
    for (size_t i = 0; i < n; i++) {
      JobPrefix jp;
      uint32_t d[8];
      std::string hex;
      if (!prepare_job(kv[i].seed, kv[i].address, jp) || !reference_digest(jp, kv[i].nonce, d)) { err = "known vector setup"; return false; }
      digest_words_to_hex(d, hex);
      if (hex != kv[i].digest) { err = "known vector digest mismatch"; return false; }
    }
  }
  JobPrefix job;
  if (!prepare_job("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
                   "albus1" + std::string("0123456789abcdef0123456789abcdef01234567"), job)) {
    err = "prepare_job failed";
    return false;
  }
  ShaNiMid mid = shani_load_state(job.mid);
  const uint64_t bases[] = {0, 12345, 0xFFFFFFFFULL - 1500, 0x100000000ULL + 12345, 0x1FFFFFFFFULL - 7, 0x123456789ABCDEF0ULL,
                            0x7FFFFFFF00000000ULL};
  for (uint64_t base : bases) {
    uint64_t room = (1ULL << 32) - (base & 0xFFFFFFFFULL);
    uint64_t count = std::min<uint64_t>(3000, room);
    for (int diff = 1; diff <= 2; diff++) {
      std::vector<Hit> a, b;
      Target t = make_target(diff), blk = make_target(diff + 1);
      scan_fast(job, &mid, base, count, t, blk, path, a);
      scan_generic(job, base, count, t, blk, b);
      bool same = a.size() == b.size();
      for (size_t i = 0; same && i < a.size(); i++) same = a[i].nonce == b[i].nonce && a[i].block == b[i].block;
      if (!same) {
        err = std::string(path_name(path)) + " path disagrees with reference at base " + nonce_to_hex(base);
        return false;
      }
    }
  }
  return true;
}

}
