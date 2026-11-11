#pragma once
#include <functional>
#include <thread>
#include "util.h"

namespace sup {

inline HANDLE worker_job() {
  static HANDLE job = [] {
    HANDLE h = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info, sizeof info);
    return h;
  }();
  return job;
}

class Child {
 public:
  std::string name;
  std::wstring exe, args;
  std::function<void(Child&, const std::string&)> onLine;

  std::atomic<bool> alive{false};
  std::atomic<bool> ready{false};
  std::atomic<uint64_t> hps{0};
  std::atomic<uint64_t> totalHashes{0};
  std::atomic<int64_t> lastBeat{0};
  std::atomic<int64_t> startedAt{0};
  std::atomic<DWORD> exitCode{0};
  std::string detail;

  ~Child() { stop(); }

  bool start() {
    static std::mutex spawnMu;
    std::lock_guard<std::mutex> g(spawnMu);
    cleanup();
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE inR = nullptr, inW = nullptr, outR = nullptr, outW = nullptr, errR = nullptr, errW = nullptr;
    if (!CreatePipe(&inR, &inW, &sa, 0) || !CreatePipe(&outR, &outW, &sa, 0) || !CreatePipe(&errR, &errW, &sa, 0)) return false;
    SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = inR;
    si.hStdOutput = outW;
    si.hStdError = errW;
    PROCESS_INFORMATION pi{};
    std::wstring cmd = L"\"" + exe + L"\" " + args;
    BOOL ok = CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &si, &pi);
    CloseHandle(inR); CloseHandle(outW); CloseHandle(errW);
    if (!ok) {
      CloseHandle(inW); CloseHandle(outR); CloseHandle(errR);
      return false;
    }
    if (!AssignProcessToJobObject(worker_job(), pi.hProcess)) {
      logger().warn("child", name + ": could not join job object (" + std::to_string(GetLastError()) + ")");
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    proc_ = pi.hProcess;
    stdinW_ = inW;
    stdoutR_ = outR;
    stderrR_ = errR;
    ready = false;
    hps = 0;
    totalHashes = 0;
    lastBeat = now_ms();
    startedAt = now_ms();
    alive = true;
    outThread_ = std::thread([this] { read_loop(stdoutR_, true); });
    errThread_ = std::thread([this] { read_loop(stderrR_, false); });
    return true;
  }

  bool send(const std::string& line) {
    std::lock_guard<std::mutex> g(writeMu_);
    if (!alive || !stdinW_) return false;
    std::string s = line + "\n";
    DWORD w = 0;
    return WriteFile(stdinW_, s.data(), (DWORD)s.size(), &w, nullptr) && w == s.size();
  }

  void stop() {
    if (proc_) {
      send("quit");
      if (WaitForSingleObject(proc_, 1500) == WAIT_TIMEOUT) TerminateProcess(proc_, 1);
    }
    cleanup();
  }

  void kill() {
    if (proc_) TerminateProcess(proc_, 1);
  }

  bool exited() {
    if (!proc_) return true;
    if (WaitForSingleObject(proc_, 0) == WAIT_OBJECT_0) {
      DWORD c = 0;
      GetExitCodeProcess(proc_, &c);
      exitCode = c;
      alive = false;
      return true;
    }
    return false;
  }

  void cleanup() {
    alive = false;
    if (stdinW_) { CloseHandle(stdinW_); stdinW_ = nullptr; }
    if (outThread_.joinable()) outThread_.join();
    if (errThread_.joinable()) errThread_.join();
    if (stdoutR_) { CloseHandle(stdoutR_); stdoutR_ = nullptr; }
    if (stderrR_) { CloseHandle(stderrR_); stderrR_ = nullptr; }
    if (proc_) {
      DWORD c = 0;
      if (GetExitCodeProcess(proc_, &c) && c != STILL_ACTIVE) exitCode = c;
      CloseHandle(proc_);
      proc_ = nullptr;
    }
  }

 private:
  HANDLE proc_ = nullptr, stdinW_ = nullptr, stdoutR_ = nullptr, stderrR_ = nullptr;
  std::thread outThread_, errThread_;
  std::mutex writeMu_;

  void read_loop(HANDLE h, bool isStdout) {
    std::string acc;
    char buf[4096];
    for (;;) {
      DWORD n = 0;
      if (!ReadFile(h, buf, sizeof buf, &n, nullptr) || n == 0) break;
      acc.append(buf, n);
      size_t pos;
      while ((pos = acc.find('\n')) != std::string::npos) {
        std::string line = acc.substr(0, pos);
        acc.erase(0, pos + 1);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        if (isStdout) {
          lastBeat = now_ms();
          if (onLine) onLine(*this, line);
        } else {
          logger().info("child.stderr", name + ": " + line);
        }
      }
      if (acc.size() > (1u << 20)) acc.clear();
    }
    if (isStdout) alive = false;
  }
};

}
