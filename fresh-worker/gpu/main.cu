// albus-gpu.exe: CUDA mining worker (NVIDIA only).
//
//   albus-gpu.exe [--device N] [--target-ms 20]     worker mode (line protocol on stdin/stdout)
//   albus-gpu.exe --selftest                        startup self-test, then exit
//   albus-gpu.exe --bench SECONDS                   throughput + launch-time report
//   albus-gpu.exe --vectors path\to\vectors.json    golden-vector run (exit code 1 on any mismatch)
//
// Crash containment: any CUDA error (including a launch timeout) or a hit that
// the host reference rejects makes this process exit; the supervisor relaunches
// it. The supervisor itself never initializes CUDA.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <random>
#include <sstream>
#include <thread>
#include <vector>
#include "../common/minijson.h"
#include "../common/proto.h"
#include "../common/scan.h"
#include "../common/selftest.h"
#include "kernel.cuh"

using namespace albus;
using namespace albus_gpu;
using Clock = std::chrono::steady_clock;

#define CK(call)                                                                                  \
  do {                                                                                            \
    cudaError_t e_ = (call);                                                                      \
    if (e_ != cudaSuccess) die(std::string(#call) + ": " + cudaGetErrorString(e_), 4);            \
  } while (0)

[[noreturn]] static void die(const std::string& msg, int code) {
  fprintf(stderr, "fatal: %s\n", msg.c_str());
  out().line("fatal " + msg);
  fflush(stdout);
  fflush(stderr);
  std::_Exit(code);
}

// ------------------------------------------------------------------ job prep
static GpuJob make_gpu_job(const JobPrefix& jp, uint64_t hi, Target share, Target block) {
  GpuJob g;
  for (int k = 0; k < 8; k++) g.w[k] = jp.inner[k];
  g.w[8] = (uint32_t)hi;
  memcpy(g.mid, jp.mid, 32);
  // Rounds 0..PRE_ROUNDS-1 only consume constant words (inner digest and the high nonce word): done once here.
  uint32_t a = jp.mid[0], b = jp.mid[1], c = jp.mid[2], d = jp.mid[3], e = jp.mid[4], f = jp.mid[5], gg = jp.mid[6], h = jp.mid[7];
  for (int t = 0; t < PRE_ROUNDS; t++) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t chv = (e & f) ^ (~e & gg);
    uint32_t t1 = h + S1 + chv + K256[t] + g.w[t];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
    h = gg; gg = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + S0 + mj;
  }
  g.pre[0] = a; g.pre[1] = b; g.pre[2] = c; g.pre[3] = d; g.pre[4] = e; g.pre[5] = f; g.pre[6] = gg; g.pre[7] = h;
  g.m0s = share.m0; g.m1s = share.m1; g.m0b = block.m0; g.m1b = block.m1;
  return g;
}

// ---------------------------------------------------------- kernel launch
static void launch_mine(int grid, int block, cudaStream_t st, const GpuJob& j, uint32_t loStart, uint32_t loops, uint32_t stride,
                        ResultBuf* r) {
  mine_kernel<<<grid, block, 0, st>>>(j, loStart, loops, stride, r);
}
static cudaError_t attr_mine(cudaFuncAttributes* a) { return cudaFuncGetAttributes(a, mine_kernel); }
static cudaError_t occ_mine(int* n, int block) { return cudaOccupancyMaxActiveBlocksPerMultiprocessor(n, mine_kernel, block, 0); }

// Full digest of one nonce on the device.
static void gpu_digest(const JobPrefix& jp, uint64_t nonce, uint32_t out[8]) {
  uint32_t *din, *dout;
  CK(cudaMalloc(&din, 32));
  CK(cudaMalloc(&dout, 32));
  CK(cudaMemcpy(din, jp.inner, 32, cudaMemcpyHostToDevice));
  digest_kernel<<<1, 1>>>(din, nonce, dout);
  CK(cudaGetLastError());
  CK(cudaMemcpy(out, dout, 32, cudaMemcpyDeviceToHost));
  cudaFree(din);
  cudaFree(dout);
}

// ------------------------------------------------------------- synchronous scan (tests)
struct GpuHit {
  uint64_t nonce;
  bool block;
};

static void gpu_scan(const JobPrefix& jp, uint64_t n0, uint64_t count, Target share, Target block, std::vector<GpuHit>& hits) {
  ResultBuf *dres, *hres;
  CK(cudaMalloc(&dres, sizeof(ResultBuf)));
  CK(cudaMallocHost(&hres, sizeof(ResultBuf)));
  uint64_t n = n0, done = 0;  // n wraps around 2^64 like the nonce does; progress is counted in `done`
  while (done < count) {
    uint64_t hi = n >> 32, lo = n & 0xFFFFFFFFULL;
    uint64_t room = (1ULL << 32) - lo;
    uint64_t want = std::min<uint64_t>(count - done, room);
    // Shrink the launch shape near a hi-word boundary so no nonce before it is skipped.
    int grid = 64, blockDim = 256;
    if (room < 64ULL * 256) { grid = 1; blockDim = 256; }
    if (room < 256) { grid = 1; blockDim = 1; }
    const uint32_t stride = (uint32_t)blockDim * grid;
    // small launches: low-difficulty tests must not overflow the result buffer
    uint32_t loops = (uint32_t)std::min<uint64_t>({(want + stride - 1) / stride, room / stride, 2});
    if (loops == 0) { done += room; n = (hi + 1) << 32; continue; }
    GpuJob j = make_gpu_job(jp, hi, share, block);
    CK(cudaMemset(dres, 0, sizeof(ResultBuf)));
    launch_mine(grid, blockDim, 0, j, (uint32_t)lo, loops, stride, dres);
    CK(cudaGetLastError());
    CK(cudaMemcpy(hres, dres, sizeof(ResultBuf), cudaMemcpyDeviceToHost));
    if (hres->shareCount > SHARE_CAP || hres->blockCount > BLOCK_CAP) die("scan result overflow in test", 6);
    for (uint32_t i = 0; i < hres->blockCount; i++) hits.push_back({(hi << 32) | hres->blockLo[i], true});
    for (uint32_t i = 0; i < hres->shareCount; i++) hits.push_back({(hi << 32) | hres->shareLo[i], false});
    uint64_t covered = (uint64_t)loops * stride;
    n += covered;
    done += covered;
  }
  cudaFree(dres);
  cudaFreeHost(hres);
  // The last launch can overshoot `end`; keep only in-range hits.
  hits.erase(std::remove_if(hits.begin(), hits.end(), [&](const GpuHit& h) { return h.nonce - n0 >= count; }), hits.end());
  std::sort(hits.begin(), hits.end(), [&](const GpuHit& a, const GpuHit& b) { return a.nonce - n0 < b.nonce - n0; });
}

// -------------------------------------------------------------- self-test
static bool gpu_selftest(std::string& err) {
  if (!cpu_selftest(best_path(), err)) return false;
  // known Node digests through the diagnostic kernel
  size_t nk;
  const KnownVector* kv = known_vectors(nk);
  for (size_t i = 0; i < nk; i++) {
    JobPrefix jp;
    prepare_job(kv[i].seed, kv[i].address, jp);
    uint64_t n;
    parse_nonce16(kv[i].nonce, n);
    uint32_t d[8];
    std::string hex;
    gpu_digest(jp, n, d);
    digest_words_to_hex(d, hex);
    if (hex != kv[i].digest) { err = "GPU digest differs from Node for known vector " + std::to_string(i); return false; }
  }
  // diagnostic kernel vs host reference at the nonce edges
  JobPrefix jp;
  prepare_job(std::string("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
              "albus1" + std::string("fedcba9876543210fedcba9876543210fedcba98"), jp);
  for (uint64_t n : {0ULL, 1ULL, 0xFFFFFFFFULL, 0x100000000ULL, 0x123456789ABCDEFULL, 0x8000000000000000ULL, ~0ULL - 1, ~0ULL}) {
    uint32_t g[8], r[8];
    gpu_digest(jp, n, g);
    reference_digest_n(jp, n, r);
    if (memcmp(g, r, 32) != 0) { err = "GPU/host digest mismatch at nonce " + nonce_to_hex(n); return false; }
  }
  // mining kernel vs host scan
  ShaNiMid mid = shani_load_state(jp.mid);
  for (uint64_t base : {777ULL, 0xFFFFFFFFULL - 5000, 0x100000000ULL + 777, 0x123456789ULL * 16, 0xf000000000000000ULL + 5, ~0ULL - (1ULL << 18)}) {
    std::vector<GpuHit> g;
    std::vector<Hit> c;
    Target share = make_target(2), block = make_target(3);
    gpu_scan(jp, base, 1 << 17, share, block, g);
    scan_range(jp, &mid, base, 1 << 17, share, block, best_path(), c);
    bool same = g.size() == c.size();
    for (size_t i = 0; same && i < g.size(); i++) same = g[i].nonce == c[i].nonce && g[i].block == c[i].block;
    if (!same) { err = "GPU mining kernel disagrees with host scan at base " + nonce_to_hex(base); return false; }
  }
  return true;
}

// ------------------------------------------------------------------ vectors
static int run_vectors(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) { printf("cannot open %s\n", path.c_str()); return 2; }
  std::stringstream ss;
  ss << f.rdbuf();
  mj::Value root;
  if (!mj::parse(ss.str(), root)) { printf("parse error\n"); return 2; }
  int fails = 0, checks = 0;

  for (const mj::Value& v : root.find("vectors")->arr) {
    JobPrefix jp;
    prepare_job(v.getString("seed"), v.getString("address"), jp);
    uint64_t n;
    parse_hex_u64(v.getString("nonce"), n);
    uint32_t d[8];
    std::string hex;
    gpu_digest(jp, n, d);
    digest_words_to_hex(d, hex);
    checks++;
    if (hex != v.getString("hash")) { if (++fails < 20) printf("FAIL digest nonce=%s\n", v.getString("nonce").c_str()); }
  }
  printf("gpu digest vectors: %zu\n", root.find("vectors")->arr.size());

  for (const mj::Value& s : root.find("scans")->arr) {
    JobPrefix jp;
    prepare_job(s.getString("seed"), s.getString("address"), jp);
    uint64_t start, count = (uint64_t)s.getNumber("count");
    parse_hex_u64(s.getString("start"), start);
    int diff = (int)s.getNumber("diff");
    uint64_t gpuStart = start;
    std::vector<std::string> want;
    for (const mj::Value& h : s.find("hits")->arr) {
      uint64_t hn;
      parse_hex_u64(h.str, hn);
      want.push_back(h.str);
    }
    std::vector<GpuHit> got;
    Target share = make_target(diff), block = make_target(diff + 1);
    gpu_scan(jp, gpuStart, start + count - gpuStart, share, block, got);
    bool same = got.size() == want.size();
    for (size_t i = 0; same && i < got.size(); i++) same = nonce_to_hex(got[i].nonce) == want[i];
    // block flag vs host reference
    for (const GpuHit& h : got) {
      uint32_t d[8];
      reference_digest_n(jp, h.nonce, d);
      if (block.met(d[0], d[1]) != h.block) same = false;
    }
    checks++;
    if (!same) { fails++; printf("FAIL scan start=%s: got %zu hits, want %zu\n", s.getString("start").c_str(), got.size(), want.size()); }
    else printf("gpu scan start=%s hits=%zu ok\n", s.getString("start").c_str(), want.size());
  }

  // random jobs: GPU vs host scan
  std::mt19937_64 rng(12345);
  ShaNiMid mid;
  for (int k = 0; k < 24; k++) {
    char seed[65], addr[47];
    for (int i = 0; i < 64; i++) seed[i] = "0123456789abcdef"[rng() & 15];
    seed[64] = 0;
    memcpy(addr, "albus1", 6);
    for (int i = 6; i < 46; i++) addr[i] = "0123456789abcdef"[rng() & 15];
    addr[46] = 0;
    JobPrefix jp;
    prepare_job(seed, addr, jp);
    mid = shani_load_state(jp.mid);
    uint64_t base = rng() >> (4 * (rng() % 15));  // all magnitudes
    std::vector<GpuHit> g;
    std::vector<Hit> c;
    Target share = make_target(2), block = make_target(3);
    gpu_scan(jp, base, 1 << 19, share, block, g);
    scan_range(jp, &mid, base, 1 << 19, share, block, best_path(), c);
    bool same = g.size() == c.size();
    for (size_t i = 0; same && i < g.size(); i++) same = g[i].nonce == c[i].nonce && g[i].block == c[i].block;
    checks++;
    if (!same) { fails++; printf("FAIL random job %d base=%llx\n", k, (unsigned long long)base); }
  }
  printf("random jobs: 24 GPU-vs-CPU scans\n");
  printf("%d checks, %d failures\n", checks, fails);
  return fails ? 1 : 0;
}

// ------------------------------------------------------------------- engine
struct Cfg {
  int block = 256;
  int grid = 0;
  uint32_t loops = 1;
  double bestRate = 0;
};

struct Slot {
  cudaStream_t st{};
  cudaEvent_t t0{}, t1{};
  ResultBuf* dRes = nullptr;
  ResultBuf* hRes = nullptr;
  uint64_t hi = 0, span = 0, gen = 0;
  std::string jobId;
  uint32_t loops = 0;
  Target share{}, block{};  // targets this launch was started with
};

class Engine {
 public:
  std::mutex mu;
  std::condition_variable cv;
  // Starts paused: the supervisor sends `duty` + `resume` only when policy allows mining.
  std::atomic<bool> quit{false}, paused{true};
  std::atomic<int> duty{100};
  std::atomic<uint64_t> hashes{0};
  uint64_t verifiedHits = 0, sentShares = 0, overflowEvents = 0;

  // job state (guarded by mu)
  std::atomic<bool> have{false};
  uint64_t gen = 0, tver = 0;
  std::string jobId;
  JobPrefix jp{};
  Target share{}, block{};
  uint64_t next = 0;

  Cfg cfg;
  std::atomic<double> targetMs{20};
  int numSMs = 0;
  double lastLaunchMs = 0, maxLaunchMs = 0;
  cudaFuncAttributes attr{};
  Slot slots[2];

  void init(int device) {
    CK(cudaSetDevice(device));
    CK(cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync));
    cudaDeviceProp p;
    CK(cudaGetDeviceProperties(&p, device));
    numSMs = p.multiProcessorCount;
    devName = p.name;
    for (auto& s : slots) {
      CK(cudaStreamCreateWithFlags(&s.st, cudaStreamNonBlocking));
      CK(cudaEventCreate(&s.t0));
      CK(cudaEventCreate(&s.t1));
      CK(cudaMalloc(&s.dRes, sizeof(ResultBuf)));
      CK(cudaMallocHost(&s.hRes, sizeof(ResultBuf)));
    }
  }
  std::string devName;

  // Tries block sizes and grid multipliers on the mining kernel, rejects configs that
  // spill to local memory and keeps the fastest one whose launches fit targetMs.
  void autotune(bool verbose) {
    JobPrefix tj;
    prepare_job(std::string(64, '1'), "albus1" + std::string(40, 'c'), tj);
    GpuJob job = make_gpu_job(tj, 0x1234, make_target(16), make_target(16));  // unreachable target: nothing is reported
    CK(attr_mine(&attr));
    if (verbose) fprintf(stderr, "kernel: regs=%d local=%zuB shared=%zuB\n", attr.numRegs, attr.localSizeBytes, attr.sharedSizeBytes);
    Cfg best;
    for (int block : {128, 256, 512}) {
      int bps = 0;
      CK(occ_mine(&bps, block));
      if (bps <= 0) continue;
      if (attr.localSizeBytes > 0) { if (verbose) fprintf(stderr, "  block=%d skipped (local memory spill)\n", block); continue; }
      for (int mult : {1, 2, 4}) {
        Cfg c;
        c.block = block;
        c.grid = numSMs * bps * mult;
        uint32_t stride = (uint32_t)c.block * c.grid;
        uint32_t maxLoops = (uint32_t)((1ULL << 31) / stride);
        uint32_t loops = 4;
        double rate = 0;
        CK(cudaMemset(slots[0].dRes, 0, sizeof(ResultBuf)));
        for (int iter = 0; iter < 9; iter++) {
          cudaEventRecord(slots[0].t0, slots[0].st);
          launch_mine(c.grid, c.block, slots[0].st, job, 0, loops, stride, slots[0].dRes);
          cudaEventRecord(slots[0].t1, slots[0].st);
          CK(cudaGetLastError());
          CK(cudaEventSynchronize(slots[0].t1));
          float ms;
          CK(cudaEventElapsedTime(&ms, slots[0].t0, slots[0].t1));
          if (iter >= 5) rate = std::max(rate, double(stride) * loops / (ms / 1000.0));
          double want = loops * (targetMs / std::max(0.05f, ms));
          loops = (uint32_t)std::clamp(want, 1.0, (double)maxLoops);
        }
        c.loops = loops;
        c.bestRate = rate;
        if (verbose) fprintf(stderr, "  block=%d grid=%d loops=%u -> %.2f GH/s\n", c.block, c.grid, c.loops, rate / 1e9);
        if (rate > best.bestRate) best = c;
      }
    }
    if (best.grid == 0) die("autotune found no usable configuration", 7);
    cfg = best;
    if (verbose) fprintf(stderr, "chosen: block=%d grid=%d loops=%u (%.2f GH/s)\n", cfg.block, cfg.grid, cfg.loops, cfg.bestRate / 1e9);
  }

  // ---- job control (called from the stdin thread)
  void set_job(const JobCmd& j) {
    JobPrefix p;
    if (!prepare_job(j.seed, j.address, p)) { fprintf(stderr, "bad job seed/address\n"); return; }
    std::mt19937_64 rng(std::random_device{}());
    std::lock_guard<std::mutex> g(mu);
    jp = p;
    jobId = j.jobId;
    share = make_target(j.shareDiff);
    block = make_target(j.blockDiff);
    // random offset so a restart does not replay; the u64 nonce wraps around, launch() tolerates that
    next = j.nonceStart + (rng() & ((1ULL << 46) - 1));
    gen++;
    tver++;
    have = true;
    cv.notify_all();
  }
  void set_diff(int s, int b) {
    std::lock_guard<std::mutex> g(mu);
    share = make_target(s);
    block = make_target(b);
    tver++;
  }

  // ---- launching
  GpuJob cachedJob{};
  uint64_t cachedHi = ~0ULL, cachedGen = ~0ULL, cachedTver = ~0ULL;

  bool launch(Slot& s) {
    std::unique_lock<std::mutex> lk(mu);
    if (!have || paused) return false;
    uint32_t stride = (uint32_t)cfg.block * cfg.grid;
    uint64_t hi, lo, room;
    for (;;) {
      hi = next >> 32;
      lo = next & 0xFFFFFFFFULL;
      room = (1ULL << 32) - lo;
      if (room >= stride) break;
      next = (hi + 1) << 32;  // not enough room for one pass: skip to the next hi word
    }
    uint32_t loops = (uint32_t)std::min<uint64_t>(cfg.loops, room / stride);
    if (hi != cachedHi || gen != cachedGen || tver != cachedTver) {
      cachedJob = make_gpu_job(jp, hi, share, block);
      cachedHi = hi; cachedGen = gen; cachedTver = tver;
    }
    s.hi = hi;
    s.gen = gen;
    s.jobId = jobId;
    s.loops = loops;
    s.share = share;
    s.block = block;
    s.span = (uint64_t)loops * stride;
    next += s.span;
    GpuJob jobCopy = cachedJob;
    lk.unlock();

    CK(cudaMemsetAsync(s.dRes, 0, 8, s.st));  // shareCount + blockCount
    CK(cudaEventRecord(s.t0, s.st));
    launch_mine(cfg.grid, cfg.block, s.st, jobCopy, (uint32_t)lo, loops, stride, s.dRes);
    CK(cudaGetLastError());
    CK(cudaEventRecord(s.t1, s.st));
    CK(cudaMemcpyAsync(s.hRes, s.dRes, sizeof(ResultBuf), cudaMemcpyDeviceToHost, s.st));
    return true;
  }

  // Waits for the slot's launch, verifies and reports its hits.
  void complete(Slot& s, bool report) {
    CK(cudaStreamSynchronize(s.st));
    float ms = 0;
    CK(cudaEventElapsedTime(&ms, s.t0, s.t1));
    lastLaunchMs = ms;
    maxLaunchMs = std::max<double>(maxLaunchMs, ms);
    hashes.fetch_add(s.span, std::memory_order_relaxed);

    // keep launches near the target: loops scale toward targetMs with light smoothing
    double want = cfg.loops * (targetMs / std::max(0.05f, ms));
    double smoothed = want < cfg.loops ? want : cfg.loops * 0.8 + want * 0.2;
    uint32_t stride = (uint32_t)cfg.block * cfg.grid;
    cfg.loops = (uint32_t)std::clamp(smoothed, 1.0, (double)((1ULL << 31) / stride));

    if (!report) return;
    JobPrefix jpCopy;
    {
      // gen and prefix are read together: a job that arrives mid-way must not pair a new prefix with old hits.
      std::lock_guard<std::mutex> g(mu);
      if (s.gen != gen) return;  // results for an older job are discarded
      jpCopy = jp;
    }

    ResultBuf& r = *s.hRes;
    if (r.shareCount > SHARE_CAP) {
      overflowEvents++;
      if (overflowEvents % 50 == 1) fprintf(stderr, "share buffer overflow (%u hits in one launch): share difficulty too low\n", r.shareCount);
    }
    auto verify_and_send = [&](uint32_t lo) {
      uint64_t nonce = (s.hi << 32) | lo;
      uint32_t d[8];
      reference_digest_n(jpCopy, nonce, d);
      // The host recomputes every winner: a GPU that produces bad hits (bad overclock, driver bug)
      // must never feed the chain. Checked against the targets this launch actually ran with.
      if (!s.share.met(d[0], d[1])) die("GPU reported a hit the host rejects (nonce " + nonce_to_hex(nonce) + ")", 5);
      verifiedHits++;
      out().line("share " + s.jobId + " " + nonce_to_hex(nonce) + " " + (s.block.met(d[0], d[1]) ? "1" : "0"));
      sentShares++;
    };
    for (uint32_t i = 0; i < std::min<uint32_t>(r.blockCount, BLOCK_CAP); i++) verify_and_send(r.blockLo[i]);
    for (uint32_t i = 0; i < std::min<uint32_t>(r.shareCount, SHARE_CAP); i++) verify_and_send(r.shareLo[i]);
  }

  void run() {
    std::deque<int> inflight;
    while (!quit) {
      int depth = duty.load() >= 100 ? 2 : 1;
      bool active = have && !paused;
      if (!active) {
        while (!inflight.empty()) { complete(slots[inflight.front()], false); inflight.pop_front(); }
        std::unique_lock<std::mutex> lk(mu);
        cv.wait_for(lk, std::chrono::milliseconds(20));
        continue;
      }
      while ((int)inflight.size() < depth) {
        int idx = -1;
        for (int i = 0; i < 2; i++)
          if (std::find(inflight.begin(), inflight.end(), i) == inflight.end()) { idx = i; break; }
        if (idx < 0 || !launch(slots[idx])) break;
        inflight.push_back(idx);
      }
      if (inflight.empty()) continue;
      int idx = inflight.front();
      inflight.pop_front();
      complete(slots[idx], true);
      int d = duty.load();
      if (d < 100) {
        // wait out the idle share of the duty cycle before launching again
        double busyMs = lastLaunchMs;
        std::this_thread::sleep_for(std::chrono::microseconds((long long)(busyMs * 1000.0 * (100 - d) / std::max(1, d))));
      }
    }
    while (!inflight.empty()) { complete(slots[inflight.front()], false); inflight.pop_front(); }
  }
};

static void command_loop(Engine& eng) {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto t = split_ws(line);
    if (t.empty()) continue;
    if (t[0] == "job") {
      JobCmd j;
      if (!parse_job(t, j)) { fprintf(stderr, "bad job command\n"); continue; }
      eng.set_job(j);
    } else if (t[0] == "diff" && t.size() == 3) {
      eng.set_diff(atoi(t[1].c_str()), atoi(t[2].c_str()));
    } else if (t[0] == "pause") {
      eng.paused = true;
    } else if (t[0] == "resume") {
      eng.paused = false;
      eng.cv.notify_all();
    } else if (t[0] == "duty" && t.size() == 2) {
      eng.duty = std::clamp(atoi(t[1].c_str()), 1, 100);
    } else if (t[0] == "target" && t.size() == 2) {
      eng.targetMs = std::clamp(atof(t[1].c_str()), 1.0, 50.0);
    } else if (t[0] == "quit") {
      break;
    }
  }
  eng.quit = true;  // EOF or quit: exit even if the supervisor vanished
  eng.cv.notify_all();
}

int main(int argc, char** argv) {
  int device = 0, bench = 0;
  bool selftestOnly = false;
  std::string vectors;
  double targetMs = 20;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--device" && i + 1 < argc) device = atoi(argv[++i]);
    else if (a == "--bench" && i + 1 < argc) bench = atoi(argv[++i]);
    else if (a == "--selftest") selftestOnly = true;
    else if (a == "--vectors" && i + 1 < argc) vectors = argv[++i];
    else if (a == "--target-ms" && i + 1 < argc) targetMs = atof(argv[++i]);
  }

  int count = 0;
  if (cudaGetDeviceCount(&count) != cudaSuccess || count == 0) die("no CUDA device available", 4);
  CK(cudaSetDevice(device));

  std::string err;
  if (!gpu_selftest(err)) die("self-test failed: " + err, 3);
  if (selftestOnly) { printf("gpu self-test ok\n"); return 0; }
  if (!vectors.empty()) return run_vectors(vectors);

  Engine eng;
  eng.targetMs = std::clamp(targetMs, 1.0, 50.0);
  eng.init(device);
  eng.autotune(bench > 0 || getenv("ALBUS_VERBOSE"));

  if (bench > 0) {
    JobPrefix tj;
    prepare_job(std::string(64, '1'), "albus1" + std::string(40, 'c'), tj);
    JobCmd j{"bench", std::string(64, '1'), "albus1" + std::string(40, 'c'), 16, 16, 0};
    eng.paused = false;
    eng.set_job(j);
    std::thread t([&] { eng.run(); });
    std::this_thread::sleep_for(std::chrono::seconds(2));  // warm-up
    uint64_t h0 = eng.hashes.load();
    eng.maxLaunchMs = 0;
    auto t0 = Clock::now();
    std::this_thread::sleep_for(std::chrono::seconds(bench));
    uint64_t h1 = eng.hashes.load();
    double dt = std::chrono::duration<double>(Clock::now() - t0).count();
    double maxMs = eng.maxLaunchMs;
    eng.quit = true;
    eng.cv.notify_all();
    t.join();
    printf("gpu bench: %s  %.3f GH/s   launch<=%.1f ms (last %.1f ms, target %.0f)  cfg block=%d grid=%d loops=%u  regs=%d local=%zuB\n",
           eng.devName.c_str(), (h1 - h0) / dt / 1e9, maxMs, eng.lastLaunchMs, eng.targetMs.load(), eng.cfg.block, eng.cfg.grid, eng.cfg.loops,
           eng.attr.numRegs, eng.attr.localSizeBytes);
    return 0;
  }

  out().line("ready gpu " + std::string("device=") + std::to_string(device) + " name=" + std::string(eng.devName).c_str() +
             " rate=" + std::to_string((uint64_t)eng.cfg.bestRate));
  std::thread mining([&] { eng.run(); });
  std::thread reporter([&] {
    uint64_t last = 0;
    auto lastT = Clock::now();
    int beat = 0;
    while (!eng.quit) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      out().line("heartbeat");
      if (++beat % 2 == 0) {
        auto now = Clock::now();
        double dt = std::chrono::duration<double>(now - lastT).count();
        uint64_t total = eng.hashes.load();
        out().line("hashrate " + std::to_string((uint64_t)((total - last) / dt)) + " " + std::to_string(total));
        last = total;
        lastT = now;
      }
    }
  });
  command_loop(eng);
  eng.quit = true;
  eng.cv.notify_all();
  mining.join();
  reporter.join();
  return 0;
}
