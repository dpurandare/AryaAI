#!/usr/bin/env bash
# Rebuilds better-sqlite3 against this machine's Electron ABI.
#
# Why: the npm-installed prebuilt binary needs GLIBC_2.33+, but this box is
# pinned to Ubuntu 20.04 (GLIBC 2.31) to keep the legacy Tesla K80 driver
# (nvidia-470, non-DKMS) working. Compiling from source needs C++20, which
# the default g++-9 doesn't support, so we install g++-10/gcc-10 *alongside*
# it (does not touch /usr/bin/gcc, /usr/bin/g++, or update-alternatives) and
# use it only for this one build via a scoped PATH override.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_DIR="$REPO_ROOT/node_modules/better-sqlite3"
ELECTRON_VERSION="$(node -p "require('$REPO_ROOT/node_modules/electron/package.json').version")"
TOOLCHAIN_BIN="$(mktemp -d)"

cleanup() { rm -rf "$TOOLCHAIN_BIN"; }
trap cleanup EXIT

echo "==> Checking g++-10/gcc-10 (installed alongside the system default, not replacing it)"
if ! dpkg -s g++-10 >/dev/null 2>&1 || ! dpkg -s gcc-10 >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y g++-10 gcc-10
else
  echo "    already installed, skipping"
fi

echo "==> System default compiler stays untouched:"
readlink -f "$(which gcc)"
readlink -f "$(which g++)"

echo "==> Building a scoped compiler PATH (gcc-10/g++-10 only for this build)"
ln -sf /usr/bin/gcc-10 "$TOOLCHAIN_BIN/gcc"
ln -sf /usr/bin/g++-10 "$TOOLCHAIN_BIN/g++"
ln -sf /usr/bin/gcc-10 "$TOOLCHAIN_BIN/cc"
ln -sf /usr/bin/g++-10 "$TOOLCHAIN_BIN/c++"

echo "==> Rebuilding better-sqlite3 from source against Electron $ELECTRON_VERSION"
rm -rf "$MODULE_DIR/build"
(
  cd "$MODULE_DIR"
  PATH="$TOOLCHAIN_BIN:$PATH" node "$REPO_ROOT/node_modules/node-gyp/bin/node-gyp.js" rebuild \
    --runtime=electron \
    --target="$ELECTRON_VERSION" \
    --arch=x64 \
    --dist-url=https://www.electronjs.org/headers \
    --build-from-source \
    --force_build=1
)

BUILT_NODE="$MODULE_DIR/build/Release/better_sqlite3.node"
PREBUILD_NODE="$MODULE_DIR/prebuilds/linux-x64.node"
if [ ! -f "$BUILT_NODE" ]; then
  echo "ERROR: build did not produce $BUILT_NODE" >&2
  exit 1
fi
cp "$BUILT_NODE" "$PREBUILD_NODE"
echo "==> Installed rebuilt binary at $PREBUILD_NODE"

echo "==> Verifying GLIBC requirement (must be <= 2.31 for this machine)"
MAX_GLIBC=$(objdump -T "$PREBUILD_NODE" | grep -oP 'GLIBC_\K[0-9.]+' | sort -V | tail -1)
echo "    max required: GLIBC_$MAX_GLIBC"
if [ "$(printf '%s\n' "$MAX_GLIBC" "2.31" | sort -V | tail -1)" != "2.31" ]; then
  echo "ERROR: rebuilt binary still needs GLIBC > 2.31 ($MAX_GLIBC) - something is off" >&2
  exit 1
fi

echo "==> Done. Run 'npm run dev' to confirm the app starts without the GLIBC/dlopen error."
