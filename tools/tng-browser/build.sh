#!/bin/sh
set -eu
# Release build only. End users open the HTTPS loader; they install nothing.
test "$#" -eq 2 || { echo 'Usage: build.sh NEW_SOURCE_DIRECTORY OUTPUT_DIRECTORY' >&2; exit 2; }
test ! -e "$1" || { echo 'Source directory must not exist' >&2; exit 2; }
metadata=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/source.json
repository=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).repository)' "$metadata")
revision=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).revision)' "$metadata")
git init "$1"
git -C "$1" remote add origin "$repository"
git -C "$1" fetch --depth=1 origin "$revision"
git -C "$1" checkout --detach FETCH_HEAD
test "$(git -C "$1" rev-parse HEAD)" = "$revision"
make -C "$1" wasm-build-release
mkdir -p "$2"
cp -R "$1/tng-wasm/pkg/." "$2/"
cp "$metadata" "$2/BUILD.json"
