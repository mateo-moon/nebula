#!/bin/sh
# Maintainer/CI build of the native runtime. Never included in the Node package.
set -eu
if [ "$#" -ne 2 ]; then echo 'Usage: build.sh NEW_SOURCE_DIRECTORY NEW_ARTIFACT_DIRECTORY' >&2; exit 2; fi
tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch="$tool_dir/tng-2.11-mainline-trustee.patch"
test ! -e "$1" && test ! -e "$2" || { echo 'Refusing to overwrite existing source or artifact directories' >&2; exit 1; }
toolchain=${TNG_BUILD_TOOLCHAIN:-1.98.1}
case "$(rustc +"$toolchain" --version)" in
  'rustc 1.98.1 '*) ;;
  *) echo 'The qualified client requires Rust 1.98.1.' >&2; exit 1 ;;
esac
git clone --depth 1 --branch v2.11.0 https://github.com/inclavare-containers/TNG.git "$1"
source_dir=$(CDPATH= cd -- "$1" && pwd)
test "$(git -C "$source_dir" rev-parse HEAD)" = 9259341240503dc645d7ad40b3a595240134cceb
git -C "$source_dir" apply --check "$patch"
git -C "$source_dir" apply "$patch"
mkdir -- "$2"
artifact_dir=$(CDPATH= cd -- "$2" && pwd)
cd "$source_dir"
target_dir=${CARGO_TARGET_DIR:-$source_dir/target}
cargo +"$toolchain" build --locked --release --target-dir "$target_dir" -p tng --bin tng --no-default-features \
  --features ingress-all,egress-all,metric,trace,tokio-console,tools
cargo +"$toolchain" test --locked --release --target-dir "$target_dir" -p rats-cert --no-default-features \
  --features crypto-rustcrypto,attester-coco,verifier-coco,attester-ita,verifier-ita,jsonwebtoken/use_pem \
  x5c_accepts_standard_and_legacy_encoding_but_rejects_invalid_data
cp "$target_dir/release/tng" "$artifact_dir/tng"
cp LICENSE "$artifact_dir/LICENSE"
{
  echo 'TNG source: https://github.com/inclavare-containers/TNG'
  echo 'TNG revision: 9259341240503dc645d7ad40b3a595240134cceb (v2.11.0)'
  printf 'Nebula revision: '
  git -C "$tool_dir" rev-parse HEAD
  printf 'Compatibility patch SHA-256: '
  shasum -a 256 "$patch" | cut -d ' ' -f 1
  rustc +"$toolchain" --version --verbose
} > "$artifact_dir/BUILD.txt"
cd "$artifact_dir"
shasum -a 256 tng LICENSE BUILD.txt > SHA256SUMS
printf 'Native runtime artifact: %s\n' "$artifact_dir"
