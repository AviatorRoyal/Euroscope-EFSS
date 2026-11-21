# Builds the India EFSS EuroScope plugin (32-bit) and its test tools.
#   powershell -ExecutionPolicy Bypass -File plugin\build.ps1 [-Config Release|Debug] [-EuroScopeDir "C:\Program Files (x86)\EuroScope"]
param(
    [string]$Config = "Release",
    [string]$EuroScopeDir = "C:\Program Files (x86)\EuroScope"
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$sdk = Join-Path $root "sdk"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "Visual Studio Build Tools not found (no vswhere.exe)." }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "No Visual Studio install with the C++ x86/x64 tools." }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvarsall.bat"

function Invoke-VsCmd([string]$cmd) {
    cmd /c "`"$vcvars`" x86 >nul && $cmd"
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $cmd" }
}

if (-not (Test-Path (Join-Path $sdk "EuroScopePlugIn.h"))) { throw "sdk\EuroScopePlugIn.h is missing." }

# Generate the import library from the EuroScopePlugInDll.dll that ships with EuroScope,
# so it always matches the installed EuroScope version.
$lib = Join-Path $sdk "EuroScopePlugInDll.lib"
if (-not (Test-Path $lib)) {
    $dll = Join-Path $EuroScopeDir "EuroScopePlugInDll.dll"
    if (-not (Test-Path $dll)) { throw "EuroScopePlugInDll.dll not found in $EuroScopeDir" }
    $exportsTxt = Join-Path $sdk "exports.txt"
    Invoke-VsCmd "dumpbin /nologo /exports `"$dll`" > `"$exportsTxt`""
    $names = Get-Content $exportsTxt | ForEach-Object {
        if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]{8}\s+(\S+)') { $Matches[1] }
    }
    if (-not $names) { throw "No exports read from $dll" }
    $def = Join-Path $sdk "EuroScopePlugInDll.def"
    @("LIBRARY EuroScopePlugInDll", "EXPORTS") + ($names | ForEach-Object { "    $_" }) | Set-Content -Encoding ascii $def
    Invoke-VsCmd "lib /nologo /def:`"$def`" /machine:x86 /out:`"$lib`""
    Write-Host "Generated $lib ($($names.Count) exports)"
}

$build = Join-Path $root "build"
Invoke-VsCmd "cmake -S `"$root`" -B `"$build`" -A Win32"
Invoke-VsCmd "cmake --build `"$build`" --config $Config"
Invoke-VsCmd "`"$build\$Config\efss_core_tests.exe`""
Write-Host "Plugin: $build\$Config\IndiaEFSS.dll"
