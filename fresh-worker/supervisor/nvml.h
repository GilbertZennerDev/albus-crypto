#pragma once
#include "util.h"

namespace sup {

struct GpuTelemetry {
  bool ok = false;
  unsigned tempC = 0;
  unsigned slowdownC = 0;
  unsigned powerMw = 0;
  unsigned smClockMhz = 0;
  unsigned long long throttleReasons = 0;
  bool hwThermalSlowdown() const {
    return (throttleReasons & (0x8ULL | 0x20ULL | 0x40ULL | 0x80ULL)) != 0;
  }
};

class Nvml {
 public:
  bool init(int index) {
    dll_ = LoadLibraryW(L"nvml.dll");
    if (!dll_) {
      wchar_t sys[MAX_PATH];
      GetSystemDirectoryW(sys, MAX_PATH);
      dll_ = LoadLibraryW((std::wstring(sys) + L"\nvml.dll").c_str());
    }
    if (!dll_) return false;
    init_ = (fnInit)GetProcAddress(dll_, "nvmlInit_v2");
    byIndex_ = (fnByIndex)GetProcAddress(dll_, "nvmlDeviceGetHandleByIndex_v2");
    temp_ = (fnTemp)GetProcAddress(dll_, "nvmlDeviceGetTemperature");
    thresh_ = (fnThresh)GetProcAddress(dll_, "nvmlDeviceGetTemperatureThreshold");
    power_ = (fnPower)GetProcAddress(dll_, "nvmlDeviceGetPowerUsage");
    clock_ = (fnClock)GetProcAddress(dll_, "nvmlDeviceGetClockInfo");
    reasons_ = (fnReasons)GetProcAddress(dll_, "nvmlDeviceGetCurrentClocksEventReasons");
    if (!reasons_) reasons_ = (fnReasons)GetProcAddress(dll_, "nvmlDeviceGetCurrentClocksThrottleReasons");
    if (!init_ || !byIndex_ || init_() != 0 || byIndex_(index, &dev_) != 0) return false;
    unsigned v = 0;
    if (thresh_ && thresh_(dev_, 1, &v) == 0) slowdown_ = v;
    ready_ = true;
    return true;
  }

  GpuTelemetry read() const {
    GpuTelemetry t;
    if (!ready_) return t;
    unsigned v = 0;
    if (temp_ && temp_(dev_, 0, &v) == 0) { t.tempC = v; t.ok = true; }
    if (power_ && power_(dev_, &v) == 0) t.powerMw = v;
    if (clock_ && clock_(dev_, 1, &v) == 0) t.smClockMhz = v;
    unsigned long long r = 0;
    if (reasons_ && reasons_(dev_, &r) == 0) t.throttleReasons = r;
    t.slowdownC = slowdown_;
    return t;
  }
  bool ready() const { return ready_; }

 private:
  using fnInit = int (*)();
  using fnByIndex = int (*)(unsigned, void**);
  using fnTemp = int (*)(void*, int, unsigned*);
  using fnThresh = int (*)(void*, int, unsigned*);
  using fnPower = int (*)(void*, unsigned*);
  using fnClock = int (*)(void*, int, unsigned*);
  using fnReasons = int (*)(void*, unsigned long long*);
  HMODULE dll_ = nullptr;
  fnInit init_ = nullptr; fnByIndex byIndex_ = nullptr; fnTemp temp_ = nullptr; fnThresh thresh_ = nullptr;
  fnPower power_ = nullptr; fnClock clock_ = nullptr; fnReasons reasons_ = nullptr;
  void* dev_ = nullptr;
  unsigned slowdown_ = 0;
  bool ready_ = false;
};

}
