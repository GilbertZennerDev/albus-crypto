// albus-supervisor.exe: per-user tray app that runs the Albus workers when the PC is idle.
//
//   * owns the single WebSocket to the chain (/mining/ws) and fans jobs out to the workers
//   * idle / lock / game / thermal policy (GetLastInputInfo, WTS notifications, NVML)
//   * restarts crashed workers with backoff; all children die with it (Job Object)
//   * JSONL logs with rotation, Windows Event Log for crashes, status.json for scripts
//
//   albus-supervisor.exe [--config path] [--console] [--always-on] [--check]
#include "util.h"  // pulls in windows.h first
#include <shellapi.h>
#include <tlhelp32.h>
#include <wtsapi32.h>
#include <deque>
#include <map>
#include <memory>
#include <thread>
#include "../common/minijson.h"
#include "child.h"
#include "nvml.h"
#include "ws.h"

using namespace sup;

namespace {

constexpr UINT WM_TRAY = WM_APP + 1;
constexpr UINT_PTR TIMER_UI = 1;
constexpr uint64_t GPU_NONCE_START = 0x100000000000ULL;   // 2^44: 12 hex chars
constexpr uint64_t CPU_NONCE_START = 0x1000000000000ULL;  // 2^48: 13 hex chars, disjoint from the GPU range

std::string hex_u64(uint64_t v) {
  char b[24];
  snprintf(b, sizeof b, "%llx", (unsigned long long)v);
  return b;
}

std::string fmt_rate(double h) {
  char b[32];
  if (h >= 1e9) snprintf(b, sizeof b, "%.2f GH/s", h / 1e9);
  else if (h >= 1e6) snprintf(b, sizeof b, "%.1f MH/s", h / 1e6);
  else if (h >= 1e3) snprintf(b, sizeof b, "%.1f kH/s", h / 1e3);
  else snprintf(b, sizeof b, "%.0f H/s", h);
  return b;
}

struct Job {
  bool have = false;
  std::string jobId, seed;
  int shareDiff = 0, blockDiff = 0;
  uint64_t epoch = 0;
};

struct Decision {
  int duty = 0;           // 0 = off, 1..100
  int gpuDuty = 0;        // per worker; they differ while the user is active
  int cpuDuty = 0;
  bool active = false;    // user is at the PC (not idle, not locked)
  std::string state;      // human readable
  int icon = 0;           // 0 grey, 1 green, 2 amber, 3 red
};

struct WorkerCtl {
  std::string kind;
  std::unique_ptr<Child> child;
  bool running = false;
  bool wanted = false;
  int64_t nextStart = 0;
  int64_t backoffMs = 1000;
  int fatalStreak = 0;
  int64_t disabledUntil = 0;
  std::string sentState;   // last pause/resume/duty pushed to the child
  uint64_t rateHint = 0;   // from the `ready` line (H/s)
  int restarts = 0;
};

class App {
 public:
  Config cfg;
  std::string address;
  bool alwaysOnFlag = false;

  // policy inputs
  std::atomic<bool> userPaused{false}, forceOn{false}, locked{false}, suspended{false}, quitting{false};

  Nvml nvml;
  GpuTelemetry tel;
  bool thermalHold = false;
  int64_t thermalHoldSince = 0;
  std::string gameName;
  int64_t lastGameCheck = 0;
  bool gameActive = false;

  // job + counters
  std::mutex jobMu;
  Job job;
  struct Stats {
    std::atomic<uint64_t> submitted{0}, accepted{0}, blocks{0}, serverStale{0}, localStale{0}, dup{0}, low{0}, malformed{0}, limit{0}, throttled{0};
  } st;
  std::map<uint64_t, int64_t> pending;
  uint64_t nextSubmitId = 1;
  double tokens = 300;
  int64_t tokenT = 0;

  WsClient ws;
  std::atomic<bool> wsConnected{false}, wantConnected{false};
  std::thread wsThread, coreThread;
  int64_t lastOffAt = 0;
  int64_t miningSince = 0;
  bool wasOn = false;
  Decision decision;
  std::mutex decMu;
  int64_t lastHashrateSend = 0;

  WorkerCtl gpu, cpu;

  // ---------------------------------------------------------------- startup
  void init() {
    gpu.kind = "gpu";
    cpu.kind = "cpu";
    address = read_wallet_address(cfg.walletFile);
    if (address.empty()) logger().error("wallet", "no address in " + cfg.walletFile.string() + "; mining cannot start until a wallet exists");
    if (nvml.init(cfg.gpuDevice)) {
      tel = nvml.read();
      logger().info("nvml", "GPU telemetry ready", "\"slowdownC\":" + std::to_string(tel.slowdownC));
    } else {
      logger().warn("nvml", "NVML unavailable; thermal policy uses only the fallback limit");
    }
    make_child(gpu, L"albus-gpu.exe", L"--device " + std::to_wstring(cfg.gpuDevice) + L" --target-ms " + std::to_wstring(cfg.gpuTargetMs));
    int threads = cfg.cpuThreads;
    if (threads < 0) threads = std::max(1u, std::thread::hardware_concurrency() / 2);
    make_child(cpu, L"albus-cpu.exe", L"--threads " + std::to_wstring(threads));
    cpuThreadsConfigured = cfg.cpuThreads;
  }
  int cpuThreadsConfigured = -1;

  void make_child(WorkerCtl& ctl, const std::wstring& exeName, const std::wstring& args) {
    ctl.child = std::make_unique<Child>();
    ctl.child->name = ctl.kind;
    ctl.child->exe = (cfg.binDir / exeName).wstring();
    ctl.child->args = args;
    WorkerCtl* c = &ctl;
    ctl.child->onLine = [this, c](Child& ch, const std::string& line) { on_worker_line(*c, ch, line); };
  }

  void start_threads() {
    wsThread = std::thread([this] { ws_loop(); });
    coreThread = std::thread([this] { core_loop(); });
  }

  void shutdown() {
    quitting = true;
    wantConnected = false;
    ws.close();
    if (coreThread.joinable()) coreThread.join();
    if (wsThread.joinable()) wsThread.join();
    gpu.child->stop();
    cpu.child->stop();
    logger().info("app", "supervisor stopped");
  }

  // ----------------------------------------------------------- worker lines
  void on_worker_line(WorkerCtl& ctl, Child& ch, const std::string& line) {
    if (line.rfind("share ", 0) == 0) return handle_share(ctl, line);
    if (line.rfind("hashrate ", 0) == 0) {
      uint64_t h = 0, total = 0;
      sscanf(line.c_str() + 9, "%llu %llu", (unsigned long long*)&h, (unsigned long long*)&total);
      ch.hps = h;
      ch.totalHashes = total;
      return;
    }
    if (line == "heartbeat") return;
    if (line.rfind("ready ", 0) == 0) {
      ch.detail = line.substr(6);
      size_t p = line.find("rate=");
      if (p != std::string::npos) ctl.rateHint = strtoull(line.c_str() + p + 5, nullptr, 10);
      else if (ctl.kind == "cpu") ctl.rateHint = 25'000'000ULL * (uint64_t)std::max(1, cpuThreadCount());
      ch.ready = true;
      ctl.sentState.clear();
      logger().info("worker.ready", ctl.kind + ": " + ch.detail);
      push_job(ctl);
      return;
    }
    if (line.rfind("fatal ", 0) == 0) {
      logger().error("worker.fatal", ctl.kind + ": " + line.substr(6));
      return;
    }
    logger().info("worker.line", ctl.kind + ": " + line);
  }

  int cpuThreadCount() const {
    int t = cpuThreadsConfigured;
    return t < 0 ? (int)std::max(1u, std::thread::hardware_concurrency() / 2) : t;
  }

  void handle_share(WorkerCtl& ctl, const std::string& line) {
    // share <jobId> <nonce> <isBlock>
    std::istringstream ss(line);
    std::string tag, jobId, nonce, blk;
    ss >> tag >> jobId >> nonce >> blk;
    bool isBlock = blk == "1";
    uint64_t id;
    {
      std::lock_guard<std::mutex> g(jobMu);
      if (!job.have || jobId != job.jobId) { st.localStale++; return; }
      int64_t now = now_ms();
      tokens = std::min(300.0, tokens + (now - tokenT) * 0.3);  // 300 shares/s sustained, bursts up to 300
      tokenT = now;
      if (tokens < 1 && !isBlock) { st.throttled++; return; }  // block-level shares are never dropped
      tokens -= 1;
      id = nextSubmitId++;
      pending[id] = now;
      if (pending.size() > 5000) pending.erase(pending.begin());
    }
    std::string msg = "{\"type\":\"submit\",\"id\":" + std::to_string(id) + ",\"jobId\":" + mj::quote(jobId) + ",\"nonce\":" + mj::quote(nonce) + "}";
    if (ws.send(msg)) {
      st.submitted++;
      if (isBlock) logger().info("share.block", ctl.kind + " submitted a block-level share", "\"nonce\":" + mj::quote(nonce));
    }
  }

  // -------------------------------------------------------------- job routing
  std::string job_command(const Job& j, uint64_t nonceStart) const {
    return "job " + j.jobId + " " + j.seed + " " + address + " " + std::to_string(j.shareDiff) + " " + std::to_string(j.blockDiff) + " " + hex_u64(nonceStart);
  }

  void push_job(WorkerCtl& ctl) {
    Job j;
    {
      std::lock_guard<std::mutex> g(jobMu);
      if (!job.have) return;
      j = job;
    }
    if (ctl.child && ctl.child->alive && ctl.child->ready)
      ctl.child->send(job_command(j, ctl.kind == "gpu" ? GPU_NONCE_START : CPU_NONCE_START));
  }

  void on_ws_message(const std::string& text) {
    mj::Value m;
    if (!mj::parse(text, m)) return;
    std::string type = m.getString("type");
    if (type == "job") {
      Job j;
      j.have = true;
      j.jobId = m.getString("jobId");
      j.seed = m.getString("seed");
      j.shareDiff = (int)m.getNumber("shareDifficulty");
      j.blockDiff = (int)m.getNumber("blockDifficulty");
      j.epoch = (uint64_t)m.getNumber("epoch");
      bool sameJob;
      {
        std::lock_guard<std::mutex> g(jobMu);
        sameJob = job.have && job.jobId == j.jobId;
        job = j;
      }
      if (sameJob) {
        // Same job, new share level: workers keep their nonce position.
        for (WorkerCtl* c : {&gpu, &cpu})
          if (c->child->alive && c->child->ready) c->child->send("diff " + std::to_string(j.shareDiff) + " " + std::to_string(j.blockDiff));
      } else {
        for (WorkerCtl* c : {&gpu, &cpu}) push_job(*c);
        logger().info("job", "new job " + j.jobId, "\"epoch\":" + std::to_string(j.epoch) + ",\"shareDiff\":" + std::to_string(j.shareDiff) + ",\"blockDiff\":" + std::to_string(j.blockDiff));
      }
      ws.send("{\"type\":\"job_ack\",\"jobId\":" + mj::quote(j.jobId) + "}");
    } else if (type == "submit_result") {
      uint64_t id = (uint64_t)m.getNumber("id");
      {
        std::lock_guard<std::mutex> g(jobMu);
        pending.erase(id);
      }
      std::string code = m.getString("code");
      if (m.getBool("accepted")) {
        st.accepted++;
        if (m.getBool("isBlock")) {
          st.blocks++;
          logger().info("block", "BLOCK accepted by the chain", "\"total\":" + std::to_string(st.blocks.load()));
        }
      } else if (code == "stale-job") st.serverStale++;
      else if (code == "duplicate") st.dup++;
      else if (code == "low-difficulty") st.low++;
      else if (code == "limit") st.limit++;
      else st.malformed++;
    } else if (type == "error") {
      logger().warn("ws.error", text);
    }
  }

  void ws_loop() {
    int64_t backoff = 1000;
    int64_t lastErrLog = 0;
    while (!quitting) {
      if (!wantConnected || address.empty()) { std::this_thread::sleep_for(std::chrono::milliseconds(250)); continue; }
      // Connect only once a worker reported its rate, so the hello carries a real hashrate hint
      // and the server picks a share level that keeps share volume low from the first job.
      if (!(gpu.child->ready || cpu.child->ready)) { std::this_thread::sleep_for(std::chrono::milliseconds(250)); continue; }
      std::string err;
      if (!ws.connect(cfg.chainWs, err)) {
        if (now_ms() - lastErrLog > 30000) { logger().warn("ws", "cannot connect to " + cfg.chainWs + ": " + err); lastErrLog = now_ms(); }
        sleep_interruptible(backoff);
        backoff = std::min<int64_t>(backoff * 2, 30000);
        continue;
      }
      int64_t connectedAt = now_ms();
      wsConnected = true;
      logger().info("ws", "connected to " + cfg.chainWs);
      ws.send("{\"type\":\"hello\",\"address\":" + mj::quote(address) + ",\"agent\":\"albus-supervisor/1.0\",\"hashrate\":" + std::to_string(total_rate_hint()) + "}");
      std::string msg;
      while (!quitting && ws.recv(msg)) on_ws_message(msg);
      wsConnected = false;
      ws.close();
      for (WorkerCtl* c : {&gpu, &cpu}) c->sentState.clear();  // re-assert pause/resume after a reconnect
      if (!quitting) logger().warn("ws", "disconnected from chain");
      backoff = (now_ms() - connectedAt > 10000) ? 1000 : std::min<int64_t>(backoff * 2, 30000);
      sleep_interruptible(backoff);
    }
  }

  void sleep_interruptible(int64_t ms) {
    for (int64_t t = 0; t < ms && !quitting && wantConnected; t += 100) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  uint64_t total_rate_hint() const {
    uint64_t r = 0;
    if (gpu.child->ready) r += gpu.rateHint;
    if (cpu.child->ready) r += cpu.rateHint;
    return r;
  }

  // ----------------------------------------------------------------- policy
  static double idle_seconds() {
    LASTINPUTINFO li{sizeof li};
    if (!GetLastInputInfo(&li)) return 0;
    return (double)(DWORD)(GetTickCount() - li.dwTime) / 1000.0;
  }

  bool foreground_fullscreen(std::string& who) {
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    wchar_t cls[64];
    GetClassNameW(fg, cls, 64);
    if (!wcscmp(cls, L"Progman") || !wcscmp(cls, L"WorkerW") || !wcscmp(cls, L"Shell_TrayWnd")) return false;
    RECT r;
    GetWindowRect(fg, &r);
    HMONITOR mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{sizeof mi};
    if (!GetMonitorInfoW(mon, &mi)) return false;
    bool covers = r.left <= mi.rcMonitor.left && r.top <= mi.rcMonitor.top && r.right >= mi.rcMonitor.right && r.bottom >= mi.rcMonitor.bottom;
    if (!covers) return false;
    LONG style = GetWindowLongW(fg, GWL_STYLE);
    if (style & WS_CAPTION) return false;  // maximised normal windows keep their caption
    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h) {
      wchar_t path[MAX_PATH];
      DWORD n = MAX_PATH;
      if (QueryFullProcessImageNameW(h, 0, path, &n)) who = to_lower(narrow(fs::path(path).filename().wstring()));
      CloseHandle(h);
    }
    return who != "explorer.exe";
  }

  void update_game_state() {
    int64_t now = now_ms();
    if (now - lastGameCheck < 2000) return;
    lastGameCheck = now;
    std::string why;
    QUERY_USER_NOTIFICATION_STATE qs;
    if (SUCCEEDED(SHQueryUserNotificationState(&qs)) && (qs == QUNS_BUSY || qs == QUNS_RUNNING_D3D_FULL_SCREEN || qs == QUNS_PRESENTATION_MODE)) why = "fullscreen app";
    if (why.empty()) {
      std::string fg;
      if (foreground_fullscreen(fg)) why = "fullscreen: " + fg;
    }
    if (why.empty()) {
      HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe{sizeof pe};
        for (BOOL ok = Process32FirstW(snap, &pe); ok && why.empty(); ok = Process32NextW(snap, &pe)) {
          std::string exe = to_lower(narrow(pe.szExeFile));
          for (auto* list : {&cfg.gameDenylist, &cfg.productivityDenylist})
            for (auto& d : *list)
              if (exe == to_lower(d)) why = exe;
        }
        CloseHandle(snap);
      }
    }
    if (why != gameName) logger().info("policy.game", why.empty() ? "no game running" : "game/fullscreen detected: " + why);
    gameName = why;
    gameActive = !why.empty();
  }

  void update_thermal() {
    if (!nvml.ready()) return;
    tel = nvml.read();
    if (!tel.ok) return;
    unsigned limit = tel.slowdownC ? tel.slowdownC : 85;  // conservative fallback when the driver reports no threshold
    bool wasHold = thermalHold;
    // A paused GPU sheds many degrees in seconds, so a hold lasts at least 30 s to avoid flapping.
    int64_t now = now_ms();
    if (tel.tempC + cfg.thermalPauseMarginC >= limit || tel.hwThermalSlowdown()) {
      if (!thermalHold) thermalHoldSince = now;
      thermalHold = true;
    } else if (thermalHold && now - thermalHoldSince >= 30000 && tel.tempC + cfg.thermalResumeMarginC <= limit) {
      thermalHold = false;
    }
    if (thermalHold != wasHold)
      logger().warn("policy.thermal", thermalHold ? "thermal hold: pausing" : "thermal hold released",
                    "\"tempC\":" + std::to_string(tel.tempC) + ",\"slowdownC\":" + std::to_string(limit));
  }

  Decision decide() {
    Decision d;
    double idle = idle_seconds();
    if (address.empty()) { d.state = "no wallet"; d.icon = 3; return d; }
    if (userPaused) { d.state = "paused by you"; return d; }
    if (suspended) { d.state = "system suspended"; return d; }
    if (gameActive) { d.state = "paused: " + gameName; return d; }
    if (thermalHold) { d.state = "paused: GPU temperature"; d.icon = 2; return d; }
    if (gpu.disabledUntil > now_ms() && cpu.disabledUntil > now_ms()) { d.state = "workers disabled after repeated failures"; d.icon = 3; return d; }

    int duty = 0;
    if (cfg.alwaysOn || forceOn) duty = 100;
    else if (locked) duty = 100;
    else if (idle >= cfg.idleStartSeconds) {
      double since = miningSince ? (now_ms() - miningSince) / 1000.0 : 0;
      double f = cfg.rampSeconds > 0 ? std::min(1.0, since / cfg.rampSeconds) : 1.0;
      duty = (int)(cfg.startDutyPercent + (100 - cfg.startDutyPercent) * f);
    } else if (cfg.activeDutyPercent > 0 || cfg.activeGpuDutyPercent > 0 || cfg.activeCpuDutyPercent > 0) {
      d.active = true;
      d.gpuDuty = cfg.activeGpuDutyPercent >= 0 ? cfg.activeGpuDutyPercent : cfg.activeDutyPercent;
      d.cpuDuty = cfg.activeCpuDutyPercent >= 0 ? cfg.activeCpuDutyPercent : cfg.activeDutyPercent;
      d.gpuDuty = std::min(100, d.gpuDuty);
      d.cpuDuty = std::min(100, d.cpuDuty);
      duty = std::max(d.gpuDuty, d.cpuDuty);
    }

    if (duty <= 0) {
      int left = (int)std::max(0.0, cfg.idleStartSeconds - idle);
      d.state = "waiting for idle (" + std::to_string(left / 60) + "m " + std::to_string(left % 60) + "s)";
      d.icon = 2;
      return d;
    }
    d.duty = std::min(100, duty);
    if (!d.active) d.gpuDuty = d.cpuDuty = d.duty;
    d.icon = 1;
    d.state = wsConnected ? "mining" : "connecting to chain";
    if (!wsConnected) d.icon = 2;
    return d;
  }

  // ------------------------------------------------------------ supervision
  void supervise(WorkerCtl& ctl, bool wanted) {
    int64_t now = now_ms();
    ctl.wanted = wanted;
    Child& ch = *ctl.child;
    if (ctl.running) {
      if (ch.exited()) {
        ch.cleanup();
        DWORD code = ch.exitCode;
        int64_t up = now - ch.startedAt;
        ctl.running = false;
        bool fatalCode = code == 3 || code == 5;
        ctl.fatalStreak = fatalCode ? ctl.fatalStreak + 1 : 0;
        ctl.backoffMs = up > 60000 ? 1000 : std::min<int64_t>(ctl.backoffMs * 2, 60000);
        ctl.nextStart = now + ctl.backoffMs;
        ctl.restarts++;
        logger().error("worker.exit", ctl.kind + " exited with code " + std::to_string(code) + " after " + std::to_string(up / 1000) + "s; restart in " + std::to_string(ctl.backoffMs / 1000) + "s");
        if (ctl.fatalStreak >= 3) {
          ctl.disabledUntil = now + 30 * 60 * 1000;
          ctl.fatalStreak = 0;
          logger().error("worker.disabled", ctl.kind + " failed its self-test or produced bad hits 3 times; disabled for 30 minutes");
        }
      } else if (ch.alive && now - ch.lastBeat > 15000) {
        logger().error("worker.hung", ctl.kind + " sent no heartbeat for 15s; killing");
        ch.kill();
      } else if (!wanted && lastOffAt && now - lastOffAt > 10 * 60 * 1000) {
        logger().info("worker.stop", ctl.kind + " stopped after 10 minutes without work (frees VRAM)");
        ch.stop();
        ctl.running = false;
        ctl.sentState.clear();
      }
      return;
    }
    if (!wanted || now < ctl.nextStart || now < ctl.disabledUntil) return;
    if (!fs::exists(ch.exe)) {
      logger().error("worker.missing", "cannot find " + narrow(ch.exe));
      ctl.nextStart = now + 60000;
      return;
    }
    if (ch.start()) {
      ctl.running = true;
      ctl.sentState.clear();
      logger().info("worker.start", ctl.kind + " started", "\"restarts\":" + std::to_string(ctl.restarts));
    } else {
      ctl.nextStart = now + 5000;
      logger().error("worker.start", "CreateProcess failed for " + narrow(ch.exe) + " (" + std::to_string(GetLastError()) + ")");
    }
  }

  int sentGpuTarget = -1;
  void apply_gpu_target(int ms) {
    if (!gpu.running || !gpu.child->ready) { sentGpuTarget = -1; return; }
    if (ms == sentGpuTarget) return;
    gpu.child->send("target " + std::to_string(ms));
    sentGpuTarget = ms;
  }

  void apply_state(WorkerCtl& ctl, const std::string& desired) {
    if (!ctl.running || !ctl.child->ready || ctl.sentState == desired) return;
    if (desired == "pause") ctl.child->send("pause");
    else {
      ctl.child->send("duty " + desired.substr(5));
      ctl.child->send("resume");
    }
    ctl.sentState = desired;
  }

  void core_loop() {
    int64_t lastTel = 0, lastStatus = 0;
    while (!quitting) {
      int64_t now = now_ms();
      if (now - lastTel >= 1000) { update_thermal(); lastTel = now; }
      update_game_state();

      Decision d = decide();
      bool on = d.duty > 0;
      if (on && !wasOn) miningSince = now;
      if (!on && wasOn) lastOffAt = now;
      wasOn = on;
      { std::lock_guard<std::mutex> g(decMu); decision = d; }

      // Keep the socket while mining and for a minute after; the chain sees no idle client.
      wantConnected = on || (lastOffAt && now - lastOffAt < 60000);

      bool wantGpu = cfg.gpu && (on || (lastOffAt && now - lastOffAt < 10 * 60 * 1000));
      bool gpuHealthy = gpu.running || gpu.disabledUntil <= now;
      bool wantCpu = false;
      if (on && d.active) wantCpu = d.cpuDuty > 0 && cpuThreadsConfigured != 0;
      else if (cpuThreadsConfigured > 0) wantCpu = on || (lastOffAt && now - lastOffAt < 10 * 60 * 1000);
      else if (cpuThreadsConfigured < 0 && (!cfg.gpu || !gpuHealthy)) wantCpu = on || (lastOffAt && now - lastOffAt < 10 * 60 * 1000);
      supervise(gpu, wantGpu);
      supervise(cpu, wantCpu);

      bool run = on && wsConnected && !address.empty();
      std::string gpuWant = run && d.gpuDuty > 0 ? "duty " + std::to_string(d.gpuDuty) : "pause";
      std::string cpuWant = run && d.cpuDuty > 0 ? "duty " + std::to_string(d.cpuDuty) : "pause";
      apply_gpu_target(d.active ? cfg.activeGpuTargetMs : cfg.gpuTargetMs);
      apply_state(gpu, gpuWant);
      apply_state(cpu, cpuWant);

      if (wsConnected && now - lastHashrateSend > 5000) {
        uint64_t h = current_hps();
        if (h > 0) ws.send("{\"type\":\"hashrate\",\"hashrate\":" + std::to_string(h) + "}");
        lastHashrateSend = now;
      }
      if (now - lastStatus >= 2000) { write_status(); lastStatus = now; }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
  }

  uint64_t current_hps() const {
    uint64_t h = 0;
    if (gpu.running && gpu.sentState != "pause") h += gpu.child->hps;
    if (cpu.running && cpu.sentState != "pause") h += cpu.child->hps;
    return h;
  }

  void write_status() {
    Decision d;
    { std::lock_guard<std::mutex> g(decMu); d = decision; }
    uint64_t submitted = st.submitted, stale = st.serverStale;
    std::ostringstream o;
    o << "{\"time\":" << mj::quote(iso_time()) << ",\"state\":" << mj::quote(d.state) << ",\"duty\":" << d.duty
      << ",\"connected\":" << (wsConnected ? "true" : "false") << ",\"address\":" << mj::quote(address)
      << ",\"gpuHps\":" << (gpu.running ? gpu.child->hps.load() : 0) << ",\"cpuHps\":" << (cpu.running ? cpu.child->hps.load() : 0)
      << ",\"gpuRunning\":" << (gpu.running ? "true" : "false") << ",\"cpuRunning\":" << (cpu.running ? "true" : "false")
      << ",\"gpuRestarts\":" << gpu.restarts << ",\"cpuRestarts\":" << cpu.restarts
      << ",\"submitted\":" << submitted << ",\"accepted\":" << st.accepted << ",\"blocks\":" << st.blocks
      << ",\"serverStale\":" << stale << ",\"localStale\":" << st.localStale << ",\"duplicate\":" << st.dup << ",\"lowDifficulty\":" << st.low
      << ",\"throttled\":" << st.throttled
      << ",\"staleRate\":" << (submitted ? (double)stale / (double)submitted : 0.0)
      << ",\"gpuTempC\":" << tel.tempC << ",\"gpuPowerW\":" << tel.powerMw / 1000 << ",\"gpuClockMhz\":" << tel.smClockMhz
      << ",\"gpuSlowdownC\":" << tel.slowdownC << ",\"thermalHold\":" << (thermalHold ? "true" : "false")
      << ",\"idleSeconds\":" << (int)idle_seconds() << ",\"locked\":" << (locked ? "true" : "false") << "}";
    fs::path p = state_dir() / "status.json";
    fs::path tmp = p;
    tmp += ".tmp";
    {
      std::ofstream f(tmp, std::ios::trunc);
      f << o.str();
    }
    MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING);
  }

  Decision current_decision() {
    std::lock_guard<std::mutex> g(decMu);
    return decision;
  }
};

App* g_app = nullptr;
NOTIFYICONDATAW g_nid{};
HWND g_hwnd = nullptr;
HICON g_icons[4] = {};
UINT g_taskbarCreated = 0;

HICON make_icon(COLORREF c) {
  const int S = 32;
  BITMAPV5HEADER bi{};
  bi.bV5Size = sizeof bi; bi.bV5Width = S; bi.bV5Height = -S; bi.bV5Planes = 1; bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000; bi.bV5GreenMask = 0x0000FF00; bi.bV5BlueMask = 0x000000FF; bi.bV5AlphaMask = 0xFF000000;
  void* bits = nullptr;
  HDC dc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(dc, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  uint32_t* px = (uint32_t*)bits;
  double cx = (S - 1) / 2.0, R = S / 2.0 - 2;
  for (int y = 0; y < S; y++)
    for (int x = 0; x < S; x++) {
      double dist = sqrt((x - cx) * (x - cx) + (y - cx) * (y - cx));
      double a = std::clamp(R + 1 - dist, 0.0, 1.0);
      bool ring = dist > R - 3;
      uint32_t r = GetRValue(c), g = GetGValue(c), b = GetBValue(c);
      if (!ring) { r = r * 7 / 10 + 76; g = g * 7 / 10 + 76; b = b * 7 / 10 + 76; }  // lighter core, solid ring
      uint32_t al = (uint32_t)(a * 255);
      px[y * S + x] = (al << 24) | ((r * al / 255) << 16) | ((g * al / 255) << 8) | (b * al / 255);
    }
  HBITMAP mask = CreateBitmap(S, S, 1, 1, nullptr);
  ICONINFO ii{TRUE, 0, 0, mask, color};
  HICON ic = CreateIconIndirect(&ii);
  DeleteObject(color);
  DeleteObject(mask);
  return ic;
}

void update_tray() {
  Decision d = g_app->current_decision();
  uint64_t h = g_app->current_hps();
  std::wstring tip = L"Albus - " + widen(d.state);
  if (d.duty > 0 && h > 0) tip += L" " + widen(fmt_rate((double)h));
  if (g_app->tel.ok) tip += L" | " + std::to_wstring(g_app->tel.tempC) + L"°C";
  wcsncpy_s(g_nid.szTip, tip.c_str(), _TRUNCATE);
  g_nid.hIcon = g_icons[std::clamp(d.icon, 0, 3)];
  g_nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

void add_tray() {
  g_nid = {};
  g_nid.cbSize = sizeof g_nid;
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = g_icons[0];
  wcscpy_s(g_nid.szTip, L"Albus");
  Shell_NotifyIconW(NIM_ADD, &g_nid);
}

void show_menu() {
  Decision d = g_app->current_decision();
  uint64_t h = g_app->current_hps();
  HMENU m = CreatePopupMenu();
  std::wstring s1 = L"Albus: " + widen(d.state);
  std::wstring s2 = L"Hashrate: " + widen(fmt_rate((double)h)) + L"   accepted " + std::to_wstring(g_app->st.accepted.load()) + L"  blocks " + std::to_wstring(g_app->st.blocks.load());
  AppendMenuW(m, MF_STRING | MF_DISABLED, 0, s1.c_str());
  AppendMenuW(m, MF_STRING | MF_DISABLED, 0, s2.c_str());
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING, 1, g_app->userPaused ? L"Resume mining" : L"Pause mining");
  AppendMenuW(m, MF_STRING | (g_app->forceOn ? MF_CHECKED : 0), 2, L"Mine now (ignore idle)");
  AppendMenuW(m, MF_STRING, 3, L"Open log folder");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING, 4, L"Quit");
  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_hwnd);
  int cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_hwnd, nullptr);
  DestroyMenu(m);
  switch (cmd) {
    case 1: g_app->userPaused = !g_app->userPaused; logger().info("user", g_app->userPaused ? "paused from tray" : "resumed from tray"); break;
    case 2: g_app->forceOn = !g_app->forceOn; logger().info("user", g_app->forceOn ? "mine-now enabled" : "mine-now disabled"); break;
    case 3: ShellExecuteW(nullptr, L"open", logger().dir().c_str(), nullptr, nullptr, SW_SHOWNORMAL); break;
    case 4: DestroyWindow(g_hwnd); break;
  }
}

LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM w, LPARAM l) {
  if (msg == g_taskbarCreated && g_taskbarCreated) { add_tray(); update_tray(); return 0; }
  switch (msg) {
    case WM_TRAY:
      if (l == WM_RBUTTONUP || l == WM_LBUTTONUP || l == WM_CONTEXTMENU) show_menu();
      return 0;
    case WM_TIMER:
      if (w == TIMER_UI) update_tray();
      return 0;
    case WM_WTSSESSION_CHANGE:
      if (w == WTS_SESSION_LOCK) { g_app->locked = true; logger().info("session", "workstation locked"); }
      else if (w == WTS_SESSION_UNLOCK) { g_app->locked = false; logger().info("session", "workstation unlocked"); }
      return 0;
    case WM_POWERBROADCAST:
      if (w == PBT_APMSUSPEND) { g_app->suspended = true; logger().info("power", "system suspending"); }
      else if (w == PBT_APMRESUMEAUTOMATIC || w == PBT_APMRESUMESUSPEND) { g_app->suspended = false; logger().info("power", "system resumed"); }
      return TRUE;
    case WM_ENDSESSION:
      if (w) { g_app->shutdown(); }
      return 0;
    case WM_DESTROY:
      KillTimer(h, TIMER_UI);
      WTSUnRegisterSessionNotification(h);
      Shell_NotifyIconW(NIM_DELETE, &g_nid);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, msg, w, l);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  fs::path exePath;
  {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    exePath = buf;
  }
  fs::path cfgPath = state_dir() / "supervisor.json";
  bool console = false, alwaysOn = false, check = false;
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    if (a == L"--config" && i + 1 < argc) cfgPath = argv[++i];
    else if (a == L"--console") console = true;
    else if (a == L"--always-on") alwaysOn = true;
    else if (a == L"--check") check = true;
  }
  if (console) {
    AllocConsole();
    FILE* f;
    freopen_s(&f, "CONOUT$", "w", stdout);
    logger().console_ = true;
  }
  logger().init(state_dir() / "logs");

  App app;
  app.cfg = load_config(cfgPath, exePath.parent_path());
  if (alwaysOn) app.cfg.alwaysOn = true;

  if (check) {
    // Self-test both workers and report through the exit code (used by the installer).
    int rc = 0;
    for (const wchar_t* exe : {L"albus-cpu.exe", L"albus-gpu.exe"}) {
      std::wstring cmd = L"\"" + (app.cfg.binDir / exe).wstring() + L"\" --selftest";
      STARTUPINFOW si{sizeof si};
      PROCESS_INFORMATION pi{};
      if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) { rc |= 1; continue; }
      WaitForSingleObject(pi.hProcess, 60000);
      DWORD c = 1;
      GetExitCodeProcess(pi.hProcess, &c);
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      logger().info("check", narrow(exe) + " self-test exit " + std::to_string(c));
      if (c != 0) rc |= 1;
    }
    return rc;
  }

  HANDLE mtx = CreateMutexW(nullptr, TRUE, L"Local\\AlbusSupervisor");
  if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;

  g_app = &app;
  app.init();
  logger().info("app", "supervisor started", "\"idleStart\":" + std::to_string(app.cfg.idleStartSeconds) + ",\"alwaysOn\":" + (app.cfg.alwaysOn ? "true" : "false"));

  g_icons[0] = make_icon(RGB(140, 140, 150));
  g_icons[1] = make_icon(RGB(46, 160, 67));
  g_icons[2] = make_icon(RGB(224, 160, 32));
  g_icons[3] = make_icon(RGB(205, 60, 60));

  WNDCLASSW wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.lpszClassName = L"AlbusSupervisorWnd";
  RegisterClassW(&wc);
  // A hidden top-level window (not HWND_MESSAGE) so it receives the TaskbarCreated broadcast.
  g_hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, L"Albus supervisor", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, hInst, nullptr);
  g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  WTSRegisterSessionNotification(g_hwnd, NOTIFY_FOR_THIS_SESSION);
  add_tray();
  SetTimer(g_hwnd, TIMER_UI, 2000, nullptr);
  app.start_threads();

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  app.shutdown();
  CloseHandle(mtx);
  return 0;
}
