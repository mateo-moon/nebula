# Native TNG client build

Maintainer and CI tooling for the native runtime consumed by
[`@nebula/trustee-client`](../../packages/trustee-client/README.md).
This directory is outside both Node package archives. The Node client accepts
an already-built TNG executable through `tngBinary` / `--tng`.

The [build workflow](../../.github/workflows/build-tng-client.yml) builds and tests
a Linux amd64 binary separately, exercises it with native mainline Trustee AS,
and uploads a `tng-client-linux-amd64-<Nebula commit>` artifact. It contains a tar
archive preserving executable permissions, `SHA256SUMS`, `BUILD.txt`, and the
upstream license. Select a successful workflow run for a reviewed commit.
Checksums detect changed bytes; approval of the build's source and workflow is
the trust decision. These are CI artifacts, not a published release channel.

After unpacking the tar archive in a private staging directory:

```sh
sha256sum --check SHA256SUMS
install -m 0755 tng /your/approved/bin/tng
```

Use the installed absolute path with the Node client. No native compiler or TNG
source checkout is required on the client machine.

## Maintainer build

Requires Git, Rust 1.98.1, a C/C++ toolchain, CMake, pkg-config and protobuf.
The source and output directories must not exist. Run from the repository root:

```sh
rustup toolchain install 1.98.1 --profile minimal
sh tools/tng-client/build.sh /path/to/new/tng-source /path/to/new/native-artifact
```

`TNG_BUILD_TOOLCHAIN=stable` is supported only when it resolves to Rust 1.98.1.
`CARGO_TARGET_DIR` can reuse a local build cache. Build and test failures prevent
successful completion; a partial output directory must not be distributed.
The script also supports the qualified macOS host toolchain; CI currently
publishes only the explicitly labelled Linux amd64 artifact.

The recipe builds pinned upstream commit
[`839da075e8dbe667fd79833181df079cd019102e`](https://github.com/inclavare-containers/TNG/commit/839da075e8dbe667fd79833181df079cd019102e),
which includes [merged compatibility PR #263](https://github.com/inclavare-containers/TNG/pull/263).
It applies the reviewed [fail-closed challenge patch](fail-closed-challenge.patch)
after verifying the exact revision. A legacy Attestation Service response can
no longer substitute a dummy nonce for a verifier-issued challenge. The build
uses the locked dependency graph, runs the CoCo verifier and challenge regression
tests, and checks that the patch is the only tracked source change. Those tests
cover pinned roots and certificate bundles, invalid trust files, token verification
and standard/legacy Base64 JWT `x5c` decoding. No local patch is applied.
Certificate and token verification remain enabled. The upstream server image
is unchanged; this patch qualifies the owner-side verifier binary.

The upstream source is licensed under Apache-2.0.
The server deployment continues to use unmodified upstream images.
