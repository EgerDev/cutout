#!/usr/bin/env bash
set -euo pipefail
# CI's upstream x86 binary; the exact release built natively on ARM Linux.
dest=${1:?usage: install-wabt.sh DESTINATION}
mkdir -p "$dest"
case "$(uname -m)" in
  x86_64)
    curl -fsSL https://github.com/WebAssembly/wabt/releases/download/1.0.37/wabt-1.0.37-ubuntu-20.04.tar.gz -o "$dest/wabt.tar.gz"
    echo "cfc675dc9b663d9adc8c75d982c1ba29f661448a2e026a67e71fe3f76a3e09f3  $dest/wabt.tar.gz" | sha256sum -c -
    tar -xzf "$dest/wabt.tar.gz" -C "$dest"
    ;;
  aarch64|arm64)
    curl -fsSL https://github.com/WebAssembly/wabt/releases/download/1.0.37/wabt-1.0.37.tar.xz -o "$dest/wabt.tar.xz"
    echo "aca7fc4ba9974ad456372ab35f9cc1bac0b9fab3321b6df399d14dda9ca8a1a9  $dest/wabt.tar.xz" | sha256sum -c -
    mkdir -p "$dest/source"
    tar -xJf "$dest/wabt.tar.xz" --strip-components=1 -C "$dest/source"
    cmake -S "$dest/source" -B "$dest/build" -DBUILD_TESTS=OFF -DBUILD_LIBWASM=OFF -DCMAKE_BUILD_TYPE=Release
    cmake --build "$dest/build" --target wat2wasm -j2
    mkdir -p "$dest/wabt-1.0.37/bin"
    cp "$dest/build/wat2wasm" "$dest/wabt-1.0.37/bin/wat2wasm"
    ;;
  *) echo 'Unsupported wabt architecture' >&2; exit 1 ;;
esac
# Upstream 1.0.37 source still declares PROJECT_VERSION 1.0.36. The archive hash pins the release.
"$dest/wabt-1.0.37/bin/wat2wasm" --version
