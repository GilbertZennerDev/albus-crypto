#pragma once
#include <winhttp.h>
#include <mutex>
#include <string>
#include "util.h"

namespace sup {

class WsClient {
 public:
  ~WsClient() { close(); }

  bool connect(const std::string& url, std::string& err) {
    close();
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof uc;
    wchar_t host[256], path[512];
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path;  uc.dwUrlPathLength = 512;
    std::wstring w = widen(url);
    bool secure = w.rfind(L"wss://", 0) == 0;
    if (w.rfind(L"ws://", 0) == 0) w = L"http://" + w.substr(5);
    else if (secure) w = L"https://" + w.substr(6);
    if (!WinHttpCrackUrl(w.c_str(), 0, 0, &uc)) { err = "bad url"; return false; }

    session_ = WinHttpOpen(L"albus-supervisor/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
    if (!session_) { err = "WinHttpOpen"; return false; }
    WinHttpSetTimeouts(session_, 5000, 5000, 10000, 0);
    connect_ = WinHttpConnect(session_, host, uc.nPort, 0);
    if (!connect_) { err = "WinHttpConnect"; close(); return false; }
    DWORD flags = secure ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET req = WinHttpOpenRequest(connect_, L"GET", path, nullptr, nullptr, nullptr, flags);
    if (!req) { err = "WinHttpOpenRequest"; close(); return false; }
    if (!WinHttpSetOption(req, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0)) { err = "upgrade option"; WinHttpCloseHandle(req); close(); return false; }
    if (!WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) || !WinHttpReceiveResponse(req, nullptr)) {
      err = "handshake failed (" + std::to_string(GetLastError()) + ")";
      WinHttpCloseHandle(req);
      close();
      return false;
    }
    ws_ = WinHttpWebSocketCompleteUpgrade(req, 0);
    WinHttpCloseHandle(req);
    if (!ws_) { err = "upgrade failed"; close(); return false; }
    DWORD ka = 20000;
    WinHttpSetOption(ws_, WINHTTP_OPTION_WEB_SOCKET_KEEPALIVE_INTERVAL, &ka, sizeof ka);
    return true;
  }

  bool send(const std::string& text) {
    std::lock_guard<std::mutex> g(sendMu_);
    HINTERNET h = ws_;
    if (!h) return false;
    return WinHttpWebSocketSend(h, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, (PVOID)text.data(), (DWORD)text.size()) == ERROR_SUCCESS;
  }

  bool recv(std::string& msg) {
    msg.clear();
    char buf[8192];
    for (;;) {
      HINTERNET h = ws_;
      if (!h) return false;
      DWORD got = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
      DWORD rc = WinHttpWebSocketReceive(h, buf, sizeof buf, &got, &type);
      if (rc != ERROR_SUCCESS) return false;
      if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) return false;
      msg.append(buf, got);
      if (msg.size() > (1u << 20)) return false;
      if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE || type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) return true;
    }
  }

  void close() {
    HINTERNET w = ws_.exchange(nullptr);
    if (w) WinHttpCloseHandle(w);
    std::lock_guard<std::mutex> g(closeMu_);
    if (connect_) { WinHttpCloseHandle(connect_); connect_ = nullptr; }
    if (session_) { WinHttpCloseHandle(session_); session_ = nullptr; }
  }
  bool open() const { return ws_.load() != nullptr; }

 private:
  HINTERNET session_ = nullptr, connect_ = nullptr;
  std::atomic<HINTERNET> ws_{nullptr};
  std::mutex sendMu_, closeMu_;
};

}
