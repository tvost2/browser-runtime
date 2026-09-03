cmake_minimum_required(VERSION 3.20)
project(bcpp LANGUAGES CXX)

# NOTE: the primary build paths are the npm scripts —
#   npm run build:wasm      → native/build-wasm.mjs   (direct em++)
#   npm run test:equivalence → g++ compiles tests/*.cpp
#   npm run bench:native     → g++ compiles tests/bench_world.cpp
# This CMakeLists is an optional alternative that mirrors those. Everything in
# native/include/bcpp is header-only C++20; the .cpp files only add entry points.

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(bcpp_headers INTERFACE)
target_include_directories(bcpp_headers INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(EMSCRIPTEN)
  # ---- WASM module: web/backend/engine.{mjs,wasm} ----
  # embind requires RTTI (do NOT add -fno-rtti). -flto + -fno-exceptions break
  # libc++ operator new resolution with this toolchain — see docs/FINDINGS.md.
  add_executable(engine bindings/engine.cpp)
  target_link_libraries(engine PRIVATE bcpp_headers)
  target_compile_options(engine PRIVATE -O3 -msimd128)
  target_link_options(engine PRIVATE
    -O3 --bind
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngine
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824
    -sSTACK_SIZE=2097152 -sENVIRONMENT=web,worker,node
    -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU32,HEAP32,HEAPU8)
  set_target_properties(engine PROPERTIES SUFFIX ".mjs")
else()
  # ---- native tests + ceiling benchmark ----
  enable_testing()

  add_executable(test_equiv       tests/test_equiv.cpp)        # math + scene.hpp (19457 checks)
  add_executable(test_world_equiv tests/test_world_equiv.cpp)  # bcpp::World core
  add_executable(bench_world      tests/bench_world.cpp)
  foreach(t test_equiv test_world_equiv bench_world)
    target_link_libraries(${t} PRIVATE bcpp_headers)
  endforeach()
  target_compile_options(test_equiv       PRIVATE -O2)
  target_compile_options(test_world_equiv PRIVATE -O2)
  target_compile_options(bench_world      PRIVATE -O3 -march=native)

  add_test(NAME equivalence       COMMAND test_equiv       ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures)
  add_test(NAME world_equivalence COMMAND test_world_equiv ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures)
endif()
