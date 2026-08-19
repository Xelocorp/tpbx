#!/usr/bin/env bash
#
# Cross-compile PJSIP (pjproject) + the pjsua2 JNI/Java bindings for Android
# with the NDK, producing:
#   pjsip-out/jniLibs/<abi>/libpjsua2.so
#   pjsip-out/java/org/pjsip/pjsua2/*.java   (SWIG-generated bindings)
#
# Milestone: single ABI (arm64-v8a), no OpenSSL yet (TLS/WSS come once the base
# engine links). Runs in CI (build-pjsip-android.yml); cannot be verified in the
# dev container, so it is iterated against CI logs.
set -euo pipefail

PJ_VERSION="${PJ_VERSION:-2.14.1}"
ABIS="${ABIS:-arm64-v8a}"
APP_PLATFORM="${APP_PLATFORM:-android-24}"
WORK="${WORK:-$PWD/pjsip-build}"
OUT="${OUT:-$PWD/pjsip-out}"

: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT must point at the NDK}"
echo "== PJSIP $PJ_VERSION for [$ABIS], platform $APP_PLATFORM"
echo "== NDK: $ANDROID_NDK_ROOT"
command -v swig >/dev/null 2>&1 || { echo "swig not found"; exit 1; }

mkdir -p "$WORK" "$OUT"
cd "$WORK"
if [ ! -d pjproject ]; then
  git clone --depth 1 --branch "$PJ_VERSION" https://github.com/pjsip/pjproject.git
fi
cd pjproject
PJROOT="$PWD"

# Mobile config: enable the Android profile from the shipped sample.
cat > pjlib/include/pj/config_site.h <<'CFG'
#define PJ_CONFIG_ANDROID 1
#include <pj/config_site_sample.h>
CFG

for ABI in $ABIS; do
  echo "==== configuring for $ABI ===="
  make distclean >/dev/null 2>&1 || true
  APP_PLATFORM="$APP_PLATFORM" TARGET_ABI="$ABI" \
    ./configure-android --use-ndk-cflags
  echo "==== make dep / make ($ABI) ===="
  make dep
  make

  echo "==== swig java bindings ($ABI) ===="
  # Builds the JNI wrapper .so and generates the Java sources.
  make -C pjsip-apps/src/swig

  mkdir -p "$OUT/jniLibs/$ABI"
  # The pjsua2 JNI library name can vary by version; grab whatever matches.
  found="$(find "$PJROOT" -name 'libpjsua2.so' -o -name 'libpjsua2*.so' | head -1 || true)"
  if [ -z "$found" ]; then
    echo "!! libpjsua2.so not produced; tree of swig dir:"
    find "$PJROOT/pjsip-apps/src/swig" -maxdepth 3 -type f | sed 's/^/   /'
    exit 1
  fi
  cp "$found" "$OUT/jniLibs/$ABI/libpjsua2.so"
  echo "   -> $OUT/jniLibs/$ABI/libpjsua2.so"
done

# Generated Java bindings (ABI-independent).
gen="$(find "$PJROOT/pjsip-apps/src/swig" -type d -path '*org/pjsip/pjsua2' | head -1 || true)"
if [ -n "$gen" ]; then
  dst="$OUT/java/org/pjsip/pjsua2"
  mkdir -p "$dst"
  cp "$gen"/*.java "$dst"/
  echo "   -> copied $(ls "$dst" | wc -l) java sources"
else
  echo "!! generated pjsua2 java sources not found; swig tree:"
  find "$PJROOT/pjsip-apps/src/swig" -maxdepth 4 -type d | sed 's/^/   /'
  exit 1
fi

echo "== done"
find "$OUT" -type f | sed 's/^/   /'
