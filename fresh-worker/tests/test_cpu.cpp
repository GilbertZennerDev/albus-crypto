// Golden-vector runner for the CPU paths.
//   albus-tests.exe path\to\vectors.json
// Node/OpenSSL produced vectors.json; every CPU path must match it bit-exactly.
#include <cstdio>
#include <fstream>
#include <sstream>
#include "../common/minijson.h"
#include "../common/proto.h"
#include "../common/scan.h"
#include "../common/selftest.h"

using namespace albus;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    g_checks++;                                                 \
    if (!(cond)) {                                              \
      g_fail++;                                                 \
      if (g_fail < 40) { printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } \
    }                                                           \
  } while (0)

static uint32_t word_of(const std::string& hex, int i) { return (uint32_t)strtoul(hex.substr(8 * i, 8).c_str(), nullptr, 16); }

static int leading_zeros_hex(const std::string& h) {
  int z = 0;
  while (z < (int)h.size() && h[z] == '0') z++;
  return z;
}

int main(int argc, char** argv) {
  std::string path = argc > 1 ? argv[1] : "golden/vectors.json";
  std::ifstream f(path, std::ios::binary);
  if (!f) { printf("cannot open %s\n", path.c_str()); return 2; }
  std::stringstream ss;
  ss << f.rdbuf();
  mj::Value root;
  if (!mj::parse(ss.str(), root)) { printf("vectors.json parse error\n"); return 2; }

  // (a) NIST
  std::string err;
  CHECK(nist_selftest(err), "NIST: %s", err.c_str());

  std::vector<Path> paths = {Path::Portable};
  CpuFeatures cf = detect_cpu();
  if (cf.avx2) paths.push_back(Path::Avx2);
  if (cf.shani) paths.push_back(Path::ShaNi);
  printf("paths under test:");
  for (Path p : paths) printf(" %s", path_name(p));
  printf("\n");

  for (Path p : paths) CHECK(cpu_selftest(p, err), "selftest %s: %s", path_name(p), err.c_str());

  // (b) full-string digests vs Node, plus (d) padding and fast-path agreement
  const mj::Value* vecs = root.find("vectors");
  int nvec = 0;
  for (const mj::Value& v : vecs->arr) {
    nvec++;
    JobPrefix job;
    std::string seed = v.getString("seed"), addr = v.getString("address"), nonce = v.getString("nonce"), want = v.getString("hash");
    CHECK(prepare_job(seed, addr, job), "prepare_job");
    uint32_t d[8];
    CHECK(reference_digest(job, nonce, d), "reference_digest");
    uint8_t bytes[32];
    for (int i = 0; i < 8; i++) { bytes[4 * i] = d[i] >> 24; bytes[4 * i + 1] = d[i] >> 16; bytes[4 * i + 2] = d[i] >> 8; bytes[4 * i + 3] = d[i]; }
    CHECK(to_hex(bytes, 32) == want, "digest mismatch %s|%s|%s", seed.c_str(), addr.c_str(), nonce.c_str());
    // reference must also equal a plain two-step SHA-256 of the raw bytes
    uint64_t n;
    CHECK(parse_nonce16(nonce, n), "nonce shape %s", nonce.c_str());
    uint8_t raw[52];
    for (int i = 0; i < 32; i++) raw[i] = uint8_t(std::stoi(seed.substr(2 * i, 2), nullptr, 16));
    for (int i = 0; i < 20; i++) raw[32 + i] = uint8_t(std::stoi(addr.substr(6 + 2 * i, 2), nullptr, 16));
    uint8_t inner[32], two[40], full[32];
    sha256_full(raw, 52, inner);
    memcpy(two, inner, 32);
    for (int k = 0; k < 8; k++) two[32 + k] = uint8_t(n >> (56 - 8 * k));
    sha256_full(two, 40, full);
    CHECK(to_hex(full, 32) == want, "sha256_full mismatch nonce=%s", nonce.c_str());

    // padding: exactly one block, bit length 320
    uint8_t blk[64];
    build_block2(job, n, blk);
    uint64_t bits = 0;
    for (int k = 0; k < 8; k++) bits = (bits << 8) | blk[56 + k];
    CHECK(bits == 320, "bit length %llu", (unsigned long long)bits);
    CHECK(blk[40] == 0x80, "0x80 position");

    // fast paths: hit at diff z, no hit at diff z+1
    {
      ShaNiMid mid = shani_load_state(job.mid);
      int z = leading_zeros_hex(want);
      for (Path p : paths) {
        std::vector<Hit> hits;
        scan_fast(job, &mid, n, 1, make_target(z), make_target(z + 1), p, hits);
        CHECK(hits.size() == 1, "%s: expected hit at diff %d nonce=%s", path_name(p), z, nonce.c_str());
        hits.clear();
        scan_fast(job, &mid, n, 1, make_target(z + 1), make_target(z + 1), p, hits);
        CHECK(hits.empty(), "%s: unexpected hit at diff %d nonce=%s", path_name(p), z + 1, nonce.c_str());
      }
    }
  }
  {
    JobPrefix j0;
    uint32_t d0[8];
    CHECK(prepare_job(std::string(64, '0'), "albus1" + std::string(40, '0'), j0), "prepare ok");
    CHECK(!prepare_job(std::string(32, '0'), "albus1" + std::string(40, '0'), j0), "16-byte seed must be refused");
    CHECK(!reference_digest(j0, "1", d0), "unpadded nonce must be refused");
    CHECK(!reference_digest(j0, "000000000000000G", d0), "non-hex nonce must be refused");
    CHECK(!reference_digest(j0, "00000000000000000", d0), "17-char nonce must be refused");
  }
  printf("vectors: %d\n", nvec);

  // (e) target boundaries
  for (const mj::Value& t : root.find("targets")->arr) {
    int n = (int)t.getNumber("n");
    Target tg = make_target(n);
    for (const char* key : {"below", "exact"}) {
      std::string h = t.getString(key);
      CHECK(tg.met(word_of(h, 0), word_of(h, 1)), "target n=%d should pass %s", n, key);
    }
    std::string fail = t.getString("fail");
    CHECK(!tg.met(word_of(fail, 0), word_of(fail, 1)), "target n=%d should fail", n);
    // and the next level must reject the exact-boundary digest
    std::string ex = t.getString("exact");
    CHECK(!make_target(n + 1).met(word_of(ex, 0), word_of(ex, 1)), "exact boundary must fail level %d", n + 1);
  }

  // range scans vs Node's exact hit sets
  for (const mj::Value& s : root.find("scans")->arr) {
    JobPrefix job;
    prepare_job(s.getString("seed"), s.getString("address"), job);
    ShaNiMid mid = shani_load_state(job.mid);
    uint64_t start;
    parse_hex_u64(s.getString("start"), start);
    uint64_t count = (uint64_t)s.getNumber("count");
    int diff = (int)s.getNumber("diff");
    const auto& want = s.find("hits")->arr;
    for (Path p : paths) {
      std::vector<Hit> hits;
      scan_range(job, &mid, start, count, make_target(diff), make_target(diff + 1), p, hits);
      bool same = hits.size() == want.size();
      for (size_t i = 0; same && i < hits.size(); i++) same = nonce_to_hex(hits[i].nonce) == want[i].str;
      CHECK(same, "%s scan start=%llx count=%llu: got %zu hits, want %zu", path_name(p), (unsigned long long)start,
            (unsigned long long)count, hits.size(), want.size());
    }
    printf("scan start=%s count=%llu hits=%zu ok\n", s.getString("start").c_str(), (unsigned long long)count, want.size());
  }

  printf("%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
