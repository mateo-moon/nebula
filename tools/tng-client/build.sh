#!/bin/sh
# Maintainer/CI build of the native runtime. Never included in the Node package.
set -eu
if [ "$#" -ne 2 ]; then echo 'Usage: build.sh NEW_SOURCE_DIRECTORY NEW_ARTIFACT_DIRECTORY' >&2; exit 2; fi
tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
revision=839da075e8dbe667fd79833181df079cd019102e
test ! -e "$1" && test ! -e "$2" || { echo 'Refusing to overwrite existing source or artifact directories' >&2; exit 1; }
toolchain=${TNG_BUILD_TOOLCHAIN:-1.98.1}
case "$(rustc +"$toolchain" --version)" in
  'rustc 1.98.1 '*) ;;
  *) echo 'The qualified client requires Rust 1.98.1.' >&2; exit 1 ;;
esac
git init --quiet "$1"
source_dir=$(CDPATH= cd -- "$1" && pwd)
git -C "$source_dir" remote add origin https://github.com/inclavare-containers/TNG.git
git -C "$source_dir" fetch --depth 1 origin "$revision"
git -C "$source_dir" checkout --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
git -C "$source_dir" apply --check "$tool_dir/fail-closed-challenge.patch"
git -C "$source_dir" apply "$tool_dir/fail-closed-challenge.patch"
mkdir -- "$2"
artifact_dir=$(CDPATH= cd -- "$2" && pwd)
cd "$source_dir"
target_dir=${CARGO_TARGET_DIR:-$source_dir/target}
cargo +"$toolchain" build --locked --release --target-dir "$target_dir" -p tng --bin tng --no-default-features \
  --features ingress-all,egress-all,metric,trace,tokio-console,tools
cargo +"$toolchain" test --locked --release --target-dir "$target_dir" -p rats-cert --lib --no-default-features \
  --features crypto-rustcrypto,attester-coco,verifier-coco,attester-ita,verifier-ita,jsonwebtoken/use_pem \
  tee::coco::verifier::
 cargo +"$toolchain" test --locked --release --target-dir "$target_dir" -p rats-cert --lib --no-default-features \
  --features crypto-rustcrypto,attester-coco,verifier-coco,attester-ita,verifier-ita,jsonwebtoken/use_pem \
  fail_closed_challenge
git -C "$source_dir" diff --binary -- rats-cert/src/tee/coco/converter/restful.rs | cmp - "$tool_dir/fail-closed-challenge.patch"
git diff --exit-code -- . ':(exclude)rats-cert/src/tee/coco/converter/restful.rs'
git diff --cached --exit-code
cp "$target_dir/release/tng" "$artifact_dir/tng"
cp LICENSE "$artifact_dir/LICENSE"
{
  echo 'TNG source: https://github.com/inclavare-containers/TNG'
  printf 'TNG revision: %s\n' "$revision"
  echo 'Source modifications: reviewed fail-closed challenge patch'
  shasum -a 256 "$tool_dir/fail-closed-challenge.patch"
  printf 'Nebula revision: '
  git -C "$tool_dir" rev-parse HEAD
  rustc +"$toolchain" --version --verbose
} > "$artifact_dir/BUILD.txt"
cd "$artifact_dir"
shasum -a 256 tng LICENSE BUILD.txt > SHA256SUMS
printf 'Native runtime artifact: %s\n' "$artifact_dir"
