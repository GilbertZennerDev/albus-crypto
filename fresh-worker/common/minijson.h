#pragma once
#include <cstdint>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace mj {

struct Value {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<Value> arr;
  std::vector<std::pair<std::string, Value>> obj;

  const Value* find(const std::string& key) const {
    for (auto& kv : obj)
      if (kv.first == key) return &kv.second;
    return nullptr;
  }
  std::string getString(const std::string& key, const std::string& def = "") const {
    auto v = find(key);
    if (!v) return def;
    if (v->type == String) return v->str;
    if (v->type == Number) return std::to_string((long long)v->num);
    return def;
  }
  double getNumber(const std::string& key, double def = 0) const {
    auto v = find(key);
    if (!v) return def;
    if (v->type == Number) return v->num;
    if (v->type == String) return atof(v->str.c_str());
    return def;
  }
  bool getBool(const std::string& key, bool def = false) const {
    auto v = find(key);
    return (v && v->type == Bool) ? v->b : def;
  }
};

class Parser {
 public:
  explicit Parser(const std::string& s) : s_(s) {}
  bool parse(Value& out) {
    skip();
    if (!value(out, 0)) return false;
    skip();
    return i_ == s_.size();
  }

 private:
  const std::string& s_;
  size_t i_ = 0;
  void skip() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\n' || s_[i_] == '\r' || s_[i_] == '\t')) i_++;
  }
  bool lit(const char* w) {
    size_t n = strlen(w);
    if (s_.compare(i_, n, w) == 0) { i_ += n; return true; }
    return false;
  }
  bool value(Value& v, int depth) {
    if (depth > 32 || i_ >= s_.size()) return false;
    char c = s_[i_];
    if (c == '{') {
      v.type = Value::Object; i_++; skip();
      if (i_ < s_.size() && s_[i_] == '}') { i_++; return true; }
      for (;;) {
        skip();
        std::string k;
        if (!string(k)) return false;
        skip();
        if (i_ >= s_.size() || s_[i_++] != ':') return false;
        skip();
        Value child;
        if (!value(child, depth + 1)) return false;
        v.obj.emplace_back(std::move(k), std::move(child));
        skip();
        if (i_ >= s_.size()) return false;
        if (s_[i_] == ',') { i_++; continue; }
        if (s_[i_] == '}') { i_++; return true; }
        return false;
      }
    }
    if (c == '[') {
      v.type = Value::Array; i_++; skip();
      if (i_ < s_.size() && s_[i_] == ']') { i_++; return true; }
      for (;;) {
        skip();
        Value child;
        if (!value(child, depth + 1)) return false;
        v.arr.push_back(std::move(child));
        skip();
        if (i_ >= s_.size()) return false;
        if (s_[i_] == ',') { i_++; continue; }
        if (s_[i_] == ']') { i_++; return true; }
        return false;
      }
    }
    if (c == '"') { v.type = Value::String; return string(v.str); }
    if (lit("true")) { v.type = Value::Bool; v.b = true; return true; }
    if (lit("false")) { v.type = Value::Bool; v.b = false; return true; }
    if (lit("null")) { v.type = Value::Null; return true; }
    char* end = nullptr;
    v.num = strtod(s_.c_str() + i_, &end);
    if (end == s_.c_str() + i_) return false;
    v.type = Value::Number;
    i_ = end - s_.c_str();
    return true;
  }
  bool string(std::string& out) {
    if (i_ >= s_.size() || s_[i_] != '"') return false;
    i_++;
    out.clear();
    while (i_ < s_.size()) {
      char c = s_[i_++];
      if (c == '"') return true;
      if (c != '\\') { out.push_back(c); continue; }
      if (i_ >= s_.size()) return false;
      char e = s_[i_++];
      switch (e) {
        case 'n': out.push_back('\n'); break;
        case 't': out.push_back('\t'); break;
        case 'r': out.push_back('\r'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'u': {
          if (i_ + 4 > s_.size()) return false;
          unsigned cp = (unsigned)strtoul(s_.substr(i_, 4).c_str(), nullptr, 16);
          i_ += 4;
          if (cp < 0x80) out.push_back((char)cp);
          else if (cp < 0x800) { out.push_back(char(0xC0 | (cp >> 6))); out.push_back(char(0x80 | (cp & 0x3F))); }
          else { out.push_back(char(0xE0 | (cp >> 12))); out.push_back(char(0x80 | ((cp >> 6) & 0x3F))); out.push_back(char(0x80 | (cp & 0x3F))); }
          break;
        }
        default: out.push_back(e);
      }
    }
    return false;
  }
};

inline bool parse(const std::string& text, Value& out) { return Parser(text).parse(out); }

inline std::string quote(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o.push_back(c);
    }
  }
  return o + "\"";
}

}
