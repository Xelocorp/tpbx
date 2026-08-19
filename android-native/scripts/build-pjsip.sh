#!/usr/bin/env bash
#
# Cross-compile PJSIP (pjproject) + the pjsua2 JNI/Java bindings for Android
# with the NDK, producing:
#   pjsip-out/jniLibs/<abi>/libpjsua2.so       SIP + media engine (SWIG JNI)
#   pjsip-out/jniLibs/<abi>/libc++_shared.so   NDK C++ runtime (pjsua2 needs it)
#   pjsip-out/java/org/pjsip/pjsua2/*.java      SWIG-generated bindings
#
# TLS is enabled by cross-compiling a static OpenSSL for each ABI and linking it
# into PJSIP (--with-ssl), so the native app can register/call over UDP, TCP and
# TLS with audio. (WSS on the native side is handled at the app layer via the
# existing WebRTC/SIP.js path; PJSIP mainline has no WebSocket transport.)
#
# Runs in CI (build-pjsip-android.yml); cannot be verified in the dev container,
# so it is iterated against CI logs.
set -euo pipefail

PJ_VERSION="${PJ_VERSION:-2.14.1}"
OPENSSL_VERSION="${OPENSSL_VERSION:-openssl-3.0.16}"
ABIS="${ABIS:-arm64-v8a}"
APP_PLATFORM="${APP_PLATFORM:-android-24}"
API="${API:-24}"
WORK="${WORK:-$PWD/pjsip-build}"
OUT="${OUT:-$PWD/pjsip-out}"

: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT must point at the NDK}"
echo "== PJSIP $PJ_VERSION + $OPENSSL_VERSION for [$ABIS], platform $APP_PLATFORM"
echo "== NDK: $ANDROID_NDK_ROOT"
command -v swig >/dev/null 2>&1 || { echo "swig not found"; exit 1; }

HOST_TAG="linux-x86_64"
TOOLCHAIN="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG"
[ -d "$TOOLCHAIN" ] || { echo "NDK toolchain not found at $TOOLCHAIN"; exit 1; }
NPROC="$(nproc 2>/dev/null || echo 2)"

mkdir -p "$WORK" "$OUT"

# --- OpenSSL target + PJSIP triple mapping per ABI -------------------------
openssl_target() {
  case "$1" in
    arm64-v8a)   echo "android-arm64" ;;
    armeabi-v7a) echo "android-arm" ;;
    x86_64)      echo "android-x86_64" ;;
    x86)         echo "android-x86" ;;
    *) echo "!! unknown ABI $1" >&2; exit 1 ;;
  esac
}

# --- Build static OpenSSL for one ABI --------------------------------------
build_openssl() {
  local ABI="$1" PREFIX="$2"
  if [ -f "$PREFIX/lib/libssl.a" ]; then
    echo "==== OpenSSL already built for $ABI"
    return 0
  fi
  echo "==== building OpenSSL ($OPENSSL_VERSION) for $ABI ===="
  cd "$WORK"
  if [ ! -d openssl-src ]; then
    git clone --depth 1 --branch "$OPENSSL_VERSION" \
      https://github.com/openssl/openssl.git openssl-src
  fi
  cd openssl-src
  make distclean >/dev/null 2>&1 || true
  # OpenSSL's android Configure uses clang from PATH + ANDROID_NDK_ROOT.
  PATH="$TOOLCHAIN/bin:$PATH" \
  ANDROID_NDK_ROOT="$ANDROID_NDK_ROOT" \
    ./Configure "$(openssl_target "$ABI")" no-shared no-tests no-ui-console \
      -D__ANDROID_API__="$API" --prefix="$PREFIX" --libdir=lib
  PATH="$TOOLCHAIN/bin:$PATH" make -j"$NPROC" >/dev/null
  PATH="$TOOLCHAIN/bin:$PATH" make install_sw >/dev/null
  echo "   -> OpenSSL installed to $PREFIX"
}

for ABI in $ABIS; do
  SSL_PREFIX="$WORK/openssl-out/$ABI"
  build_openssl "$ABI" "$SSL_PREFIX"

  echo "==== fetching pjproject ===="
  cd "$WORK"
  if [ ! -d pjproject ]; then
    git clone --depth 1 --branch "$PJ_VERSION" \
      https://github.com/pjsip/pjproject.git
  fi
  cd pjproject
  PJROOT="$PWD"

  # Mobile config: enable the Android profile from the shipped sample.
  cat > pjlib/include/pj/config_site.h <<'CFG'
#define PJ_CONFIG_ANDROID 1
#include <pj/config_site_sample.h>
CFG

  echo "==== configuring PJSIP for $ABI (with TLS) ===="
  make distclean >/dev/null 2>&1 || true
  CFLAGS="-I$SSL_PREFIX/include" \
  LDFLAGS="-L$SSL_PREFIX/lib" \
  APP_PLATFORM="$APP_PLATFORM" TARGET_ABI="$ABI" \
    ./configure-android --use-ndk-cflags --with-ssl="$SSL_PREFIX"

  echo "---- SSL support line from configure ----"
  grep -i "ssl" config.log 2>/dev/null | grep -i "support" | head -5 || true

  echo "==== make dep / make ($ABI) ===="
  make dep
  make

  echo "==== swig java bindings ($ABI) ===="
  make -C pjsip-apps/src/swig

  mkdir -p "$OUT/jniLibs/$ABI"
  found="$(find "$PJROOT" -name 'libpjsua2.so' | head -1 || true)"
  if [ -z "$found" ]; then
    echo "!! libpjsua2.so not produced; tree of swig dir:"
    find "$PJROOT/pjsip-apps/src/swig" -maxdepth 3 -type f | sed 's/^/   /'
    exit 1
  fi
  cp "$found" "$OUT/jniLibs/$ABI/libpjsua2.so"
  echo "   -> $OUT/jniLibs/$ABI/libpjsua2.so"

  # pjsua2 is C++ and links the NDK's shared C++ runtime; ship it per ABI.
  cxx="$(find "$TOOLCHAIN" -name 'libc++_shared.so' -path "*$ABI*" | head -1 || true)"
  if [ -z "$cxx" ]; then
    # fall back to the arch sysroot dir name used by the NDK
    case "$ABI" in
      arm64-v8a)   arch=aarch64-linux-android ;;
      armeabi-v7a) arch=arm-linux-androideabi ;;
      x86_64)      arch=x86_64-linux-android ;;
      x86)         arch=i686-linux-android ;;
    esac
    cxx="$(find "$TOOLCHAIN" -name 'libc++_shared.so' -path "*$arch*" | head -1 || true)"
  fi
  if [ -n "$cxx" ]; then
    cp "$cxx" "$OUT/jniLibs/$ABI/libc++_shared.so"
    echo "   -> $OUT/jniLibs/$ABI/libc++_shared.so"
  else
    echo "!! libc++_shared.so not found for $ABI under $TOOLCHAIN"
    exit 1
  fi
done

# Generated Java bindings (ABI-independent). SWIG writes them to
#   pjsip-apps/src/swig/java/android/pjsua2/src/main/java/org/pjsip/pjsua2/
# Locate by the generated JNI wrapper (pjsua2JNI.java) so we never pick up the
# sample app's org/pjsip/pjsua2/app directory (which has no bindings).
jni="$(find "$WORK/pjproject/pjsip-apps/src/swig" -name 'pjsua2JNI.java' | head -1 || true)"
if [ -n "$jni" ]; then
  gen="$(dirname "$jni")"
  dst="$OUT/java/org/pjsip/pjsua2"
  mkdir -p "$dst"
  cp "$gen"/*.java "$dst"/
  echo "   -> copied $(ls "$dst" | wc -l) java sources from $gen"
else
  echo "!! generated pjsua2 java sources not found (no pjsua2JNI.java); swig tree:"
  find "$WORK/pjproject/pjsip-apps/src/swig" -type d | sed 's/^/   /'
  exit 1
fi

echo "== done"
find "$OUT" -type f | sed 's/^/   /'
