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

Use the installed absolute path with the Node client. No compiler or source
checkout is required on the client machine.

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

The recipe verifies TNG v2.11.0 commit
`9259341240503dc645d7ad40b3a595240134cceb`, applies the adjacent patch, uses the
locked dependency graph, and runs the certificate-decoding regression test.
The patch supports mainline Trustee's pinned verifier CA and standard Base64
JWT `x5c` values. Certificate and token verification remain enabled.
[Upstream compatibility PR](https://github.com/inclavare-containers/TNG/pull/263).

The patch contains context from TNG v2.11.0, licensed under Apache-2.0.
The server deployment continues to use unmodified upstream images.
