#!/usr/bin/env bash
set -euo pipefail
# Installation tooling, separate from Nebula's TypeScript runtime. No workload
# policy is generated here. Requires git, make, Rust 1.98.1 and protoc.
revision=5b57d5c41ffb9d9515e76ef51cfa851068cfc439
output=${1:?Usage: build.sh OUTPUT_DIRECTORY}
mkdir -p "$output"
output=$(cd "$output" && pwd)
source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
git -C "$source_dir" init --quiet
git -C "$source_dir" remote add origin https://github.com/kata-containers/kata-containers.git
git -C "$source_dir" fetch --depth=1 origin "$revision"
git -C "$source_dir" checkout --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
make -C "$source_dir/src/tools/genpolicy" src/version.rs
cargo +1.98.1 build --manifest-path "$source_dir/Cargo.toml" --locked --release -p genpolicy
install -m 0755 "$source_dir/target/release/genpolicy" "$output/genpolicy"
printf 'Kata source: %s\nRust: 1.98.1\n' "$revision" > "$output/BUILD.txt"
