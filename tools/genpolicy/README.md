# Native genpolicy installation

Nebula invokes the upstream `genpolicy` executable during Trustee synthesis. It
does not build Rust, fetch source, or accept pre-generated workload policies at
runtime. Install the tool separately, like Helm.

`build.sh OUTPUT_DIRECTORY` builds unmodified Kata source at
`5b57d5c41ffb9d9515e76ef51cfa851068cfc439` using Rust 1.98.1 and the upstream
version-file target. Install Rust 1.98.1, protobuf's `protoc`, git, make and a C
compiler first. The binary builds on Linux and macOS. Put it on PATH or set
`genpolicy.executable` in `TrusteeConfig`.

Kata 4.2.0's guest-pull policy does not validate `source`. The pinned revision
contains the upstream image/digest validation. Nebula checks the generator's
revision and supplies its versioned restrictive rules/settings profile through
native `-p` and `-j` options. See the module's `assets/genpolicy/README.md`.
