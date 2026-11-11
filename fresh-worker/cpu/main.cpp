// albus-cpu.exe: CPU mining worker. Speaks the line protocol in common/proto.h.
//   albus-cpu.exe [--threads N] [--selftest] [--bench SECONDS]
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <thread>
#include <vector>
#include "../common/proto.h"
#include "../common/scan.h"
#include "../common/selftest.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

using namespace albus;
using Clock = std::chrono::steady_clock;

namespace {

struct Snap {
  uint64_t gen = 0;
  std::string jobId;
  JobPrefix prefix{};
  ShaNiMid mid{};
  uint64_t nonceStart = 1ULL << 32;
};

std::mutex g_snapMu;
std::shared_ptr<const Snap> g_snap;
std::atomic<uint64_t> g_gen{0};
std::atomic<bool> g_quit{false};
// Workers start paused: the supervisor sends `duty` + `resume` only when policy allows mining.
std::atomic<bool> g_paused{true};
std::atomic<int> g_duty{100};
std::atomic<uint32_t> g_shareM0{0}, g_shareM1{0}, g_blockM0{0}, g_blockM1{0};
std::atomic<uint64_t> g_hashes{0};
Path g_path = Path::Portable;

void set_targets(int shareDiff, int blockDiff) {
  Target s = make_target(shareDiff), b = make_target(blockDiff);
  g_shareM0 = s.m0; g_shareM1 = s.m1; g_blockM0 = b.m0; g_blockM1 = b.m1;
}

void hash_thread(int tid) {
  uint64_t seenGen = 0;
  std::shared_ptr<const Snap> snap;
  uint64_t n = 0;
  std::vector<Hit> hits;
  constexpr uint64_t CHUNK = 1 << 16;
  auto burstStart = Clock::now();
  while (!g_quit) {
    uint64_t gen = g_gen.load(std::memory_order_acquire);
    if (gen != seenGen || !snap) {
      std::lock_guard<std::mutex> g(g_snapMu);
      snap = g_snap;
      if (!snap) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
      seenGen = snap->gen;
      // Thread slices are 2^40 apart so threads never overlap; a fresh random
      // offset per (re)start keeps a restarted worker from re-submitting nonces.
      std::mt19937_64 rng(std::random_device{}());
      n = snap->nonceStart + (uint64_t)tid * (1ULL << 40) + (rng() & ((1ULL << 38) - 1));
    }
    if (g_paused) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); burstStart = Clock::now(); continue; }

    uint64_t room = (1ULL << 32) - (n & 0xFFFFFFFFULL);
    uint64_t cnt = std::min<uint64_t>(CHUNK, room);
    Target share{g_shareM0.load(std::memory_order_relaxed), g_shareM1.load(std::memory_order_relaxed)};
    Target block{g_blockM0.load(std::memory_order_relaxed), g_blockM1.load(std::memory_order_relaxed)};
    hits.clear();
    scan_fast(snap->prefix, &snap->mid, n, cnt, share, block, g_path, hits);
    n += cnt;
    g_hashes.fetch_add(cnt, std::memory_order_relaxed);
    // A newer job may have arrived while this chunk ran: never report against it.
    if (g_gen.load(std::memory_order_acquire) == seenGen) {
      // Block-level winners first, so the chain sees the block before more shares.
      std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.block > b.block; });
      for (const Hit& h : hits) out().line("share " + snap->jobId + " " + nonce_to_hex(h.nonce) + " " + (h.block ? "1" : "0"));
    }

    int duty = g_duty.load(std::memory_order_relaxed);
    if (duty < 100) {
      auto now = Clock::now();
      auto worked = std::chrono::duration_cast<std::chrono::microseconds>(now - burstStart).count();
      if (worked >= 20000) {
        std::this_thread::sleep_for(std::chrono::microseconds(worked * (100 - duty) / std::max(1, duty)));
        burstStart = Clock::now();
      }
    }
  }
}

void command_loop() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto t = split_ws(line);
    if (t.empty()) continue;
    if (t[0] == "job") {
      JobCmd j;
      if (!parse_job(t, j)) { fprintf(stderr, "bad job command\n"); continue; }
      auto s = std::make_shared<Snap>();
      if (!prepare_job(j.seed, j.address, s->prefix)) { fprintf(stderr, "bad job seed/address\n"); continue; }
      s->mid = shani_load_state(s->prefix.mid);
      s->jobId = j.jobId;
      s->nonceStart = j.nonceStart < (1ULL << 32) ? j.nonceStart + (1ULL << 32) : j.nonceStart;
      set_targets(j.shareDiff, j.blockDiff);
      {
        std::lock_guard<std::mutex> g(g_snapMu);
        s->gen = g_gen.load() + 1;
        g_snap = s;
        g_gen.store(s->gen, std::memory_order_release);
      }
    } else if (t[0] == "diff" && t.size() == 3) {
      set_targets(atoi(t[1].c_str()), atoi(t[2].c_str()));
    } else if (t[0] == "pause") {
      g_paused = true;
    } else if (t[0] == "resume") {
      g_paused = false;
    } else if (t[0] == "duty" && t.size() == 2) {
      g_duty = std::clamp(atoi(t[1].c_str()), 1, 100);
    } else if (t[0] == "quit") {
      break;
    }
  }
  g_quit = true;  // EOF: the supervisor is gone.
}

int run_bench(int threads, int seconds) {
  std::vector<std::thread> ts;
  auto s = std::make_shared<Snap>();
  prepare_job(std::string(64, '1'), "albus1" + std::string(40, 'a'), s->prefix);
  s->mid = shani_load_state(s->prefix.mid);
  s->jobId = "bench";
  s->gen = 1;
  g_snap = s;
  g_gen = 1;
  g_paused = false;
  set_targets(12, 12);  // essentially never hits
  for (int i = 0; i < threads; i++) ts.emplace_back(hash_thread, i);
  std::this_thread::sleep_for(std::chrono::seconds(seconds));
  uint64_t total = g_hashes.load();
  g_quit = true;
  for (auto& t : ts) t.join();
  printf("cpu bench: path=%s threads=%d  %.2f MH/s\n", path_name(g_path), threads, total / 1e6 / seconds);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  int threads = std::max(1u, std::thread::hardware_concurrency() / 2);
  bool selftest = false;
  int bench = 0;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--threads" && i + 1 < argc) threads = std::max(1, atoi(argv[++i]));
    else if (a == "--selftest") selftest = true;
    else if (a == "--bench" && i + 1 < argc) bench = atoi(argv[++i]);
  }
  g_path = best_path();

  std::string err;
  if (!cpu_selftest(g_path, err)) {
    out().line("fatal selftest failed: " + err);
    fprintf(stderr, "self-test failed: %s\n", err.c_str());
    return 3;
  }
  if (selftest) {
    printf("cpu self-test ok (path=%s)\n", path_name(g_path));
    return 0;
  }
  if (bench > 0) return run_bench(threads, bench);

#ifdef _WIN32
  // Below-normal so a foreground app always wins the scheduler.
  SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
#endif
  std::vector<std::thread> ts;
  for (int i = 0; i < threads; i++) ts.emplace_back(hash_thread, i);
  out().line(std::string("ready cpu ") + path_name(g_path) + " threads=" + std::to_string(threads));

  std::thread reporter([] {
    uint64_t last = 0;
    auto lastT = Clock::now();
    int beat = 0;
    while (!g_quit) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      if (++beat % 4 == 0) {
        out().line("heartbeat");
        auto now = Clock::now();
        double dt = std::chrono::duration<double>(now - lastT).count();
        uint64_t total = g_hashes.load();
        out().line("hashrate " + std::to_string((uint64_t)((total - last) / dt)) + " " + std::to_string(total));
        last = total;
        lastT = now;
      }
    }
  });
  command_loop();
  g_quit = true;
  for (auto& t : ts) t.join();
  reporter.join();
  return 0;
}
