# Build PJSIP's pjsua command-line softphone (the native sidecar) for Windows
# x64 with MSVC, linked against OpenSSL so it registers/calls over UDP, TCP and
# TLS (WSS stays on SIP.js/WebRTC in the renderer). The Electron main process
# drives this over stdio to carry audio natively. Iterated against CI logs
# (build-pjsua-windows.yml) — cannot be built in the Linux dev container.
# See docs/NATIVE_SOFTPHONE.md.

$ErrorActionPreference = "Stop"

$pjVersion = $env:PJ_VERSION
if (-not $pjVersion) { $pjVersion = "2.14.1" }

$work = Join-Path $PSScriptRoot "pjbuild"
$out  = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path $out  | Out-Null

Write-Host "== pjsua $pjVersion (x64, MSVC, TLS/OpenSSL)"

# --- OpenSSL (for TLS transport) -------------------------------------------
# Use the runner's OpenSSL if present, else install the slproweb build.
$sslRoot = "C:\Program Files\OpenSSL-Win64"
if (-not (Test-Path (Join-Path $sslRoot "include\openssl\ssl.h"))) {
  Write-Host "== installing OpenSSL via choco"
  choco install openssl --no-progress -y | Out-Null
}
if (-not (Test-Path $sslRoot)) {
  # Fall back to any OpenSSL-* dir under Program Files.
  $cand = Get-ChildItem "C:\Program Files" -Directory -Filter "OpenSSL*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) { $sslRoot = $cand.FullName }
}
if (-not (Test-Path (Join-Path $sslRoot "include\openssl\ssl.h"))) {
  throw "OpenSSL headers not found under $sslRoot"
}
Write-Host "== OpenSSL: $sslRoot"

# Locate the include root by finding openssl/asn1.h (robust to layout).
$asn1 = Get-ChildItem -Path $sslRoot -Recurse -Filter "asn1.h" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "openssl" } | Select-Object -First 1
if (-not $asn1) { throw "openssl/asn1.h not found under $sslRoot" }
$incDir = Split-Path (Split-Path $asn1.FullName -Parent) -Parent   # .../include

# Import libs: PJSIP's ssl_sock links libssl.lib / libcrypto.lib.
$libssl = Get-ChildItem -Path $sslRoot -Recurse -Filter "libssl.lib" -ErrorAction SilentlyContinue | Select-Object -First 1
$libcrypto = Get-ChildItem -Path $sslRoot -Recurse -Filter "libcrypto.lib" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($libssl -and $libcrypto) {
  $libDir = $libssl.Directory.FullName
} else {
  # Older slproweb naming (libssl64MD.lib): copy to the expected names.
  $altSsl = Get-ChildItem -Path $sslRoot -Recurse -Filter "libssl*MD.lib" -ErrorAction SilentlyContinue | Select-Object -First 1
  $altCrypto = Get-ChildItem -Path $sslRoot -Recurse -Filter "libcrypto*MD.lib" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not ($altSsl -and $altCrypto)) { throw "OpenSSL import libs not found under $sslRoot" }
  $libDir = Join-Path $work "ssl-libs"
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  Copy-Item $altSsl.FullName (Join-Path $libDir "libssl.lib") -Force
  Copy-Item $altCrypto.FullName (Join-Path $libDir "libcrypto.lib") -Force
}
Write-Host "== OpenSSL include: $incDir"
Write-Host "== OpenSSL libs:    $libDir"

# --- PJSIP -----------------------------------------------------------------
Set-Location $work
if (-not (Test-Path pjproject)) {
  git clone --depth 1 --branch $pjVersion https://github.com/pjsip/pjproject.git
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}
Set-Location pjproject
$pjroot = (Get-Location).Path

# Enable the OpenSSL-backed TLS transport.
@"
/* XeloVoice desktop sidecar build */
#define PJ_HAS_SSL_SOCK 1
"@ | Out-File -Encoding ascii (Join-Path $pjroot "pjlib\include\pj\config_site.h")

# Patch: pjproject 2.14.1's parse_ossl_asn1_time() reads the ASN1_TIME struct
# fields directly (tm->type/data/length). Modern OpenSSL makes asn1_string_st
# opaque, so MSVC fails with C2037. Rewrite those three lines to use the public
# accessor functions (available since OpenSSL 1.1.0).
$osslC = Join-Path $pjroot "pjlib\src\pj\ssl_sock_ossl.c"
$src = Get-Content -Raw $osslC
$src = $src.Replace("utc = tm->type == V_ASN1_UTCTIME;",
                    "utc = ASN1_STRING_type((const ASN1_STRING*)tm) == V_ASN1_UTCTIME;")
$src = $src.Replace("p = (char*)tm->data;",
                    "p = (char*)ASN1_STRING_get0_data((const ASN1_STRING*)tm);")
$src = $src.Replace("len = tm->length;",
                    "len = ASN1_STRING_length((const ASN1_STRING*)tm);")
Set-Content -Encoding ascii $osslC $src
Write-Host "== patched ssl_sock_ossl.c ASN1 accessors"

# Inject OpenSSL include/lib into every project. MSBuild derives cl's include
# path from project properties (not the ambient INCLUDE env), so a
# Directory.Build.props at the tree root is the reliable way to add them.
$props = @"
<Project>
  <ItemDefinitionGroup>
    <ClCompile>
      <AdditionalIncludeDirectories>`$(OPENSSL_INCLUDE);%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <AdditionalLibraryDirectories>`$(OPENSSL_LIB);%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
      <AdditionalDependencies>libssl.lib;libcrypto.lib;%(AdditionalDependencies)</AdditionalDependencies>
    </Link>
    <Lib>
      <AdditionalLibraryDirectories>`$(OPENSSL_LIB);%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Lib>
  </ItemDefinitionGroup>
</Project>
"@
$props | Out-File -Encoding utf8 (Join-Path $pjroot "Directory.Build.props")

$sln = Get-ChildItem -Path $pjroot -Filter "pjproject-vs*.sln" | Select-Object -First 1
if (-not $sln) { throw "no pjproject-vs*.sln found under $pjroot" }
Write-Host "== solution: $($sln.Name)"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild `
  -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "MSBuild not found via vswhere" }
Write-Host "== msbuild: $msbuild"

& $msbuild $sln.FullName `
  /t:pjsua `
  /p:Configuration=Release `
  /p:Platform=x64 `
  /p:PlatformToolset=v143 `
  /p:WindowsTargetPlatformVersion=10.0 `
  /p:OPENSSL_INCLUDE="$incDir" `
  /p:OPENSSL_LIB="$libDir" `
  /m /nologo /v:minimal
if ($LASTEXITCODE -ne 0) { throw "msbuild failed ($LASTEXITCODE)" }

# --- collect exe + runtime OpenSSL DLLs ------------------------------------
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

# Ship the OpenSSL DLLs next to pjsua.exe (dynamically linked).
foreach ($pat in @("libssl*x64.dll", "libcrypto*x64.dll", "libssl-3*.dll", "libcrypto-3*.dll")) {
  Get-ChildItem -Path (Join-Path $sslRoot "bin") -Filter $pat -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $out $_.Name) -Force }
}

Write-Host "== done. out/:"
Get-ChildItem $out | Format-Table Name,Length -AutoSize
