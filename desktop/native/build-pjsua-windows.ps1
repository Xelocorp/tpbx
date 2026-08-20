# Build PJSIP's pjsua command-line softphone (the native sidecar) for Windows
# x64 with MSVC. The Electron main process drives this over stdio to carry audio
# on UDP/TCP/TLS (WSS stays on SIP.js/WebRTC). Iterated against CI logs
# (build-pjsua-windows.yml) — cannot be built in the Linux dev container.
#
# Milestone D1: get the MSVC toolchain green (UDP/TCP). OpenSSL/TLS is layered
# in next (D1b). See docs/NATIVE_SOFTPHONE.md.

$ErrorActionPreference = "Stop"

$pjVersion = $env:PJ_VERSION
if (-not $pjVersion) { $pjVersion = "2.14.1" }

$work = Join-Path $PSScriptRoot "pjbuild"
$out  = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path $out  | Out-Null

Write-Host "== pjsua $pjVersion (x64, MSVC)"

Set-Location $work
if (-not (Test-Path pjproject)) {
  git clone --depth 1 --branch $pjVersion https://github.com/pjsip/pjproject.git
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}
Set-Location pjproject
$pjroot = (Get-Location).Path

# PJSIP requires a config_site.h to exist; desktop defaults are fine for D1.
"/* XeloVoice desktop sidecar build (defaults; TLS added in D1b) */" |
  Out-File -Encoding ascii (Join-Path $pjroot "pjlib\include\pj\config_site.h")

# Locate the shipped VS solution (name carries the toolset, e.g. -vs14).
$sln = Get-ChildItem -Path $pjroot -Filter "pjproject-vs*.sln" | Select-Object -First 1
if (-not $sln) { throw "no pjproject-vs*.sln found under $pjroot" }
Write-Host "== solution: $($sln.Name)"

# Find MSBuild via vswhere (VS2022 on windows-latest).
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild `
  -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "MSBuild not found via vswhere" }
Write-Host "== msbuild: $msbuild"

# Build just the pjsua sample app (and its deps) for x64/Release, retargeting
# the old solution's toolset to the installed one.
& $msbuild $sln.FullName `
  /t:pjsua `
  /p:Configuration=Release `
  /p:Platform=x64 `
  /p:PlatformToolset=v143 `
  /p:WindowsTargetPlatformVersion=10.0 `
  /m /nologo /v:minimal
if ($LASTEXITCODE -ne 0) { throw "msbuild failed ($LASTEXITCODE)" }

# Collect the produced exe.
$exe = Get-ChildItem -Path $pjroot -Recurse -Filter "pjsua.exe" |
  Where-Object { $_.FullName -match "x64" } | Select-Object -First 1
if (-not $exe) {
  $exe = Get-ChildItem -Path $pjroot -Recurse -Filter "pjsua*.exe" | Select-Object -First 1
}
if (-not $exe) {
  Write-Host "!! pjsua.exe not produced; exe tree:"
  Get-ChildItem -Path $pjroot -Recurse -Filter "*.exe" | ForEach-Object { Write-Host "   $($_.FullName)" }
  throw "pjsua.exe not found"
}
Copy-Item $exe.FullName (Join-Path $out "pjsua.exe") -Force
Write-Host "== done -> $out\pjsua.exe"
Get-Item (Join-Path $out "pjsua.exe") | Format-List Name,Length,FullName
