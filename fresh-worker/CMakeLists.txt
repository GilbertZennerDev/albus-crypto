cmake_minimum_required(VERSION 3.24)
project(AlbusWorker LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 20)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

if(MSVC)
  add_compile_options($<$<COMPILE_LANGUAGE:CXX>:/O2> $<$<COMPILE_LANGUAGE:CXX>:/EHsc> $<$<COMPILE_LANGUAGE:CXX>:/utf-8>
                      $<$<COMPILE_LANGUAGE:CXX>:/W3> $<$<COMPILE_LANGUAGE:CXX>:/permissive->)
  add_compile_definitions(NOMINMAX _CRT_SECURE_NO_WARNINGS)
endif()

# CPU worker + golden-vector runner (plain C++, SHA-NI / AVX2 / portable paths)
add_executable(albus-cpu cpu/main.cpp)
add_executable(albus-tests tests/test_cpu.cpp)

# CUDA worker. Pinned to the RTX 4070 (sm_89); one SASS build, no PTX JIT.
add_executable(albus-gpu gpu/main.cu)
set_target_properties(albus-gpu PROPERTIES CUDA_ARCHITECTURES 89 CUDA_SEPARABLE_COMPILATION OFF)
target_compile_options(albus-gpu PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-O3> $<$<COMPILE_LANGUAGE:CUDA>:-Xptxas=-v>
                       $<$<COMPILE_LANGUAGE:CUDA>:-lineinfo>)

# Tray supervisor: Win32 GUI subsystem, talks to the chain over WinHTTP WebSocket.
if(WIN32 AND EXISTS ${CMAKE_SOURCE_DIR}/supervisor/main.cpp)
  add_executable(albus-supervisor WIN32 supervisor/main.cpp)
  target_link_libraries(albus-supervisor PRIVATE winhttp user32 shell32 gdi32 wtsapi32 advapi32 ole32 pdh)
endif()
