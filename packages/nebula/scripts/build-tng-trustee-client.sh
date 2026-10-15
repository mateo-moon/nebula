#!/bin/sh
# Build the narrowly patched CLIENT. The deployed server uses upstream TNG.
set -eu
if [ "$#" -ne 1 ]; then echo 'Usage: build-tng-trustee-client.sh NEW_SOURCE_DIRECTORY' >&2; exit 2; fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch="$script_dir/../src/modules/k8s/trustee/patches/tng-2.11-mainline-trustee.patch"
test ! -e "$1" || { echo 'Refusing to overwrite an existing directory' >&2; exit 1; }
toolchain=${TNG_BUILD_TOOLCHAIN:-stable}
case "$(rustc +"$toolchain" --version)" in
  'rustc 1.98.1 '*) ;;
  *) echo 'This prototype was qualified with Rust 1.98.1. Select that toolchain with TNG_BUILD_TOOLCHAIN.' >&2; exit 1 ;;
esac
git clone --depth 1 --branch v2.11.0 https://github.com/inclavare-containers/TNG.git "$1"
test "$(git -C "$1" rev-parse HEAD)" = 9259341240503dc645d7ad40b3a595240134cceb
git -C "$1" apply --check "$patch"
git -C "$1" apply "$patch"
cd "$1"
cargo +"$toolchain" build --locked --release -p tng --bin tng --no-default-features \
  --features ingress-all,egress-all,metric,trace,tokio-console,tools
cargo +"$toolchain" test --locked --release -p rats-cert --no-default-features \
  --features crypto-rustcrypto,attester-coco,verifier-coco,attester-ita,verifier-ita,jsonwebtoken/use_pem \
  x5c_accepts_standard_and_legacy_encoding_but_rejects_invalid_data
printf 'Built client: %s/target/release/tng\n' "$(pwd)"
