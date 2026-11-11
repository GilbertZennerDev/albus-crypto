#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>
#include "../common/minijson.h"

namespace sup {

namespace fs = std::filesystem;

inline std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
inline std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

inline int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline fs::path state_dir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  fs::path p = n ? fs::path(buf) : fs::temp_directory_path();
  p /= "Albus";
  std::error_code ec;
  fs::create_directories(p, ec);
  return p;
}

inline std::string iso_time() {
  SYSTEMTIME st;
  GetLocalTime(&st);
  char b[40];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  return b;
}

class Logger {
 public:
  void init(const fs::path& dir) {
    std::lock_guard<std::mutex> g(m_);
    std::error_code ec;
    fs::create_directories(dir, ec);
    path_ = dir / "supervisor.jsonl";
    open();
    evt_ = RegisterEventSourceW(nullptr, L"AlbusSupervisor");
  }
  void write(const char* level, const std::string& ev, const std::string& msg, const std::string& extra = "") {
    std::string line = "{\"t\":\"" + iso_time() + "\",\"lvl\":\"" + level + "\",\"ev\":" + mj::quote(ev) + ",\"msg\":" + mj::quote(msg);
    if (!extra.empty()) line += "," + extra;
    line += "}\n";
    {
      std::lock_guard<std::mutex> g(m_);
      if (!out_.is_open()) return;
      out_ << line;
      out_.flush();
      size_ += line.size();
      if (size_ > 5 * 1024 * 1024) rotate();
    }
    if (console_) fputs(line.c_str(), stdout);
    if (level[0] == 'e' && evt_) {
      std::wstring w = widen(ev + ": " + msg);
      const wchar_t* strs[1] = {w.c_str()};
      ReportEventW(evt_, EVENTLOG_ERROR_TYPE, 0, 1, nullptr, 1, 0, strs, nullptr);
    }
  }
  void info(const std::string& ev, const std::string& msg, const std::string& extra = "") { write("info", ev, msg, extra); }
  void warn(const std::string& ev, const std::string& msg, const std::string& extra = "") { write("warn", ev, msg, extra); }
  void error(const std::string& ev, const std::string& msg, const std::string& extra = "") { write("error", ev, msg, extra); }
  bool console_ = false;
  fs::path dir() const { return path_.parent_path(); }

 private:
  void open() {
    out_.open(path_, std::ios::app);
    std::error_code ec;
    size_ = fs::exists(path_, ec) ? (size_t)fs::file_size(path_, ec) : 0;
  }
  void rotate() {
    out_.close();
    std::error_code ec;
    fs::remove(path_.string() + ".3", ec);
    fs::rename(path_.string() + ".2", path_.string() + ".3", ec);
    fs::rename(path_.string() + ".1", path_.string() + ".2", ec);
    fs::rename(path_, path_.string() + ".1", ec);
    open();
  }
  std::mutex m_;
  std::ofstream out_;
  fs::path path_;
  size_t size_ = 0;
  HANDLE evt_ = nullptr;
};

inline Logger& logger() {
  static Logger l;
  return l;
}

struct Config {
  std::string chainWs = "ws://127.0.0.1:4000/mining/ws";
  fs::path walletFile;
  fs::path binDir;
  bool gpu = true;
  int cpuThreads = -1;
  int idleStartSeconds = 300;
  int rampSeconds = 60;
  int startDutyPercent = 25;
  int activeDutyPercent = 0;
  int activeGpuDutyPercent = -1;
  int activeCpuDutyPercent = -1;
  int activeGpuTargetMs = 4;
  bool alwaysOn = false;
  int gpuTargetMs = 20;
  int thermalPauseMarginC = 5;
  int thermalResumeMarginC = 15;
  int gpuDevice = 0;
  std::vector<std::string> gameDenylist = {"eldenring.exe", "cyberpunk2077.exe", "cs2.exe", "valorant-win64-shipping.exe",
                                           "fortniteclient-win64-shipping.exe", "gta5.exe", "witcher3.exe", "bg3.exe",
                                           "bg3_dx11.exe", "hogwartslegacy.exe", "dota2.exe", "r5apex.exe", "overwatch.exe",
                                           "starfield.exe", "helldivers2.exe", "rocketleague.exe", "leagueoflegends.exe"};
  std::vector<std::string> productivityDenylist;
};

inline Config load_config(const fs::path& cfgPath, const fs::path& exeDir) {
  Config c;
  c.binDir = exeDir;
  c.walletFile = state_dir() / "wallet.json";
  std::ifstream f(cfgPath, std::ios::binary);
  if (!f) return c;
  std::stringstream ss;
  ss << f.rdbuf();
  mj::Value v;
  if (!mj::parse(ss.str(), v) || v.type != mj::Value::Object) {
    logger().warn("config", "supervisor.json is not valid JSON; using defaults");
    return c;
  }
  c.chainWs = v.getString("chainWs", c.chainWs);
  if (auto s = v.getString("walletFile"); !s.empty()) c.walletFile = s;
  if (auto s = v.getString("binDir"); !s.empty()) c.binDir = s;
  if (auto p = v.find("gpu"); p && p->type == mj::Value::Bool) c.gpu = p->b;
  c.cpuThreads = (int)v.getNumber("cpuThreads", c.cpuThreads);
  c.idleStartSeconds = (int)v.getNumber("idleStartSeconds", c.idleStartSeconds);
  c.rampSeconds = (int)v.getNumber("rampSeconds", c.rampSeconds);
  c.startDutyPercent = (int)v.getNumber("startDutyPercent", c.startDutyPercent);
  c.activeDutyPercent = (int)v.getNumber("activeDutyPercent", c.activeDutyPercent);
  c.activeGpuDutyPercent = (int)v.getNumber("activeGpuDutyPercent", c.activeGpuDutyPercent);
  c.activeCpuDutyPercent = (int)v.getNumber("activeCpuDutyPercent", c.activeCpuDutyPercent);
  c.activeGpuTargetMs = (int)v.getNumber("activeGpuTargetMs", c.activeGpuTargetMs);
  c.alwaysOn = v.getBool("alwaysOn", c.alwaysOn);
  c.gpuTargetMs = (int)v.getNumber("gpuTargetMs", c.gpuTargetMs);
  c.thermalPauseMarginC = (int)v.getNumber("thermalPauseMarginC", c.thermalPauseMarginC);
  c.thermalResumeMarginC = (int)v.getNumber("thermalResumeMarginC", c.thermalResumeMarginC);
  c.gpuDevice = (int)v.getNumber("gpuDevice", c.gpuDevice);
  if (auto d = v.find("gameDenylist"); d && d->type == mj::Value::Array) {
    c.gameDenylist.clear();
    for (auto& e : d->arr) c.gameDenylist.push_back(e.str);
  }
  if (auto d = v.find("productivityDenylist"); d && d->type == mj::Value::Array)
    for (auto& e : d->arr) c.productivityDenylist.push_back(e.str);
  return c;
}

inline std::string to_lower(std::string s) {
  for (auto& ch : s) ch = (char)tolower((unsigned char)ch);
  return s;
}

inline std::string read_wallet_address(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f) return {};
  std::stringstream ss;
  ss << f.rdbuf();
  std::string text = ss.str();
  if (text.size() >= 3 && (unsigned char)text[0] == 0xEF) text = text.substr(3);
  mj::Value v;
  if (!mj::parse(text, v)) return {};
  return v.getString("address");
}

}
