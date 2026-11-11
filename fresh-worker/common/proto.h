#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace albus {

inline std::vector<std::string> split_ws(const std::string& line) {
  std::vector<std::string> out;
  std::istringstream ss(line);
  std::string tok;
  while (ss >> tok) out.push_back(tok);
  return out;
}

inline bool parse_hex_u64(const std::string& s, uint64_t& out) {
  if (s.empty() || s.size() > 16) return false;
  uint64_t v = 0;
  for (char c : s) {
    int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
    if (d < 0) return false;
    v = (v << 4) | (uint64_t)d;
  }
  out = v;
  return true;
}

struct JobCmd {
  std::string jobId, seed, address;
  int shareDiff = 0, blockDiff = 0;
  uint64_t nonceStart = 0;
};

inline bool parse_job(const std::vector<std::string>& t, JobCmd& j) {
  if (t.size() != 7 || t[0] != "job") return false;
  j.jobId = t[1];
  j.seed = t[2];
  j.address = t[3];
  j.shareDiff = atoi(t[4].c_str());
  j.blockDiff = atoi(t[5].c_str());
  return parse_hex_u64(t[6], j.nonceStart) && j.shareDiff >= 1 && j.shareDiff <= 16 && j.blockDiff >= 1 && j.blockDiff <= 16;
}

class Out {
 public:
  void line(const std::string& s) {
    std::lock_guard<std::mutex> g(m_);
    fwrite(s.data(), 1, s.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
  }

 private:
  std::mutex m_;
};

inline Out& out() {
  static Out o;
  return o;
}

}
