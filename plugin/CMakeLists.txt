cmake_minimum_required(VERSION 3.20)
project(india_efss_plugin CXX)

# EuroScope is a 32-bit application: configure with  -A Win32
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(WARNING "EuroScope plugins must be 32-bit. Configure with: cmake -A Win32")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the DLL has no Visual C++ redistributable dependency.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/W4 /permissive- /utf-8 /EHsc)
add_compile_definitions(_CRT_SECURE_NO_WARNINGS WIN32_LEAN_AND_MEAN NOMINMAX)

add_library(efss_core STATIC
  src/core/Json.cpp
  src/core/Sha1.cpp
  src/core/WsServer.cpp
  src/core/Protocol.cpp
  src/core/Bridge.cpp)
target_link_libraries(efss_core PUBLIC ws2_32)

# The EuroScope plugin DLL
set(ES_IMPORT_LIB ${CMAKE_CURRENT_SOURCE_DIR}/sdk/EuroScopePlugInDll.lib)
if(EXISTS ${ES_IMPORT_LIB})
  add_library(IndiaEFSS SHARED src/plugin/EfssPlugin.cpp)
  target_link_libraries(IndiaEFSS PRIVATE efss_core ${ES_IMPORT_LIB})
else()
  message(WARNING "sdk/EuroScopePlugInDll.lib missing: run build.ps1 to generate it. Plugin target skipped.")
endif()

# Test tools (no EuroScope needed)
add_executable(efss_mock_server tools/mock_server.cpp)
target_link_libraries(efss_mock_server PRIVATE efss_core)
add_executable(efss_core_tests tools/core_tests.cpp)
target_link_libraries(efss_core_tests PRIVATE efss_core)
