# Confidential workload operator

A standalone Go operator scaffolded with Kubebuilder 4.16.0 and built on
controller-runtime. Install through Nebula's `ConfidentialOperator` construct;
declare `ConfidentialWorkload` and `ConfidentialStorage` resources as described
in the [module guide](../nebula/src/modules/k8s/confidential-workloads/README.md).

The controller watches declarations, Pods, Services and block claims in explicit
namespaces. A namespace-scoped leader lease serializes reconciliation. It
reuses existing guests after restarts, repairs owned Service ports, and reports
`UpdatePending` for changed workload declarations. Retire the current Pod
explicitly, then enroll and provision its replacement. Storage claims are never
deleted or adopted by the controller.

The bundled TypeScript renderer uses the pinned official Trustee chart and
native genpolicy. The owner CLI independently uses that same implementation.
Its bounded JSON protocol carries public declarations and rendered manifests;
Kubernetes status does not establish trust in a guest.

Owner credentials, enrollment pins and image/storage keys never enter this
operator. Its namespace Roles grant no Secret, exec, attach, Pod update/delete,
or storage mutation permissions. Keys are provisioned by the owner directly to
the attested, enrolled guest.

## Development

```sh
pnpm install --frozen-lockfile
make generate manifests
pnpm typecheck && pnpm test
go test -race ./...
```

`make generate` updates Go deepcopy code. `make manifests` exports the existing
structural CRD schemas and CEL rules from Nebula. Go preserves the complete spec
as JSON so admission, rendering and owner verification share one schema and
validator. Do not replace these manifests with schemas inferred from the Go
routing projections.

For the real API integration test, install Kubernetes 1.35 test binaries using
`setup-envtest`, set `KUBEBUILDER_ASSETS` to their directory, then run
`make envtest`. The test covers admission, watches, namespace scope, identical
workloads and controller restart without replacing guests.

Build from the repository root:

```sh
docker build -f docker/confidential-operator/Dockerfile -t confidential-operator .
```

Pin the published image digest when installing. The image bundles the Go
manager and qualified Nebula synthesis toolchain; it does not rebuild Helm
chart dependencies.
