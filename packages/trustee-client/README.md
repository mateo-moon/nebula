# @nebula/trustee-client

Node owner client for Nebula's [self-sufficient Trustee deployment](../nebula/src/modules/k8s/trustee/TNG.md).
Like `@nebula/cli`, this package ships TypeScript under `src/`, with a thin
launcher in `bin/` and typed command handlers under `src/commands/`. The launcher
runs the source through the declared `tsx` dependency. The public API also exports
TypeScript source, following `nebula-cdk8s`; use `tsx` or your application's
TypeScript tooling. There is no JavaScript build or prepack step.

The client starts a local, digest-pinned mainline Trustee Attestation Service
(AS) and the qualified native TNG client. AS verifies the SNP report and the
approved VM/workload tuple. TNG binds that evidence to the server's TLS key.
After verifying an authenticated round trip, Node provisions Trustee through
its native owner JWT API. No external bootstrap Trustee is involved.

## Install and prepare

Requires Node >=20.19, OpenSSL, a trusted local Docker runtime with a Unix socket,
and the patched native TNG executable. Linux and macOS are supported; the verifier
image runs as `linux/amd64`. The owner's computer and its Docker VM are trusted.
Remote Docker endpoints are rejected. Do not run this client on an excluded
infrastructure administrator's machine.

From the repository root, install with Node 24 and pnpm 11.9.0
(Node 20 development uses pnpm 10.34.6), as with `packages/cli`:

```sh
cd packages/trustee-client
pnpm install --frozen-lockfile
pnpm exec tsx src/cli.ts --help
./bin/nebula-trustee --help
```

The package declares `nebula-cdk8s: file:../nebula`, like `@nebula/cli`. It imports
the shared policy and verifier plan through `nebula-cdk8s/trustee/policies` and
`nebula-cdk8s/trustee/client-plan`. Those TypeScript exports load only the pure
Trustee helpers; the client does not copy or compile a sibling package's source.

For installation outside a checkout, pack both packages from the same reviewed
revision with `pnpm pack --pack-destination /your/artifacts`. In the consuming
project, select the matching Nebula archive in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
overrides:
  nebula-cdk8s: file:/your/artifacts/nebula-cdk8s-1.1.0.tgz
```

Then install and run the client:

```sh
pnpm add /your/artifacts/nebula-trustee-client-0.1.0.tgz tsx
pnpm exec nebula-trustee --help
```

Run a TypeScript application with `pnpm exec tsx app.ts`. The examples below use
the installed `nebula-trustee` command; from the checkout, use
`./bin/nebula-trustee` instead.

TNG is a separately built native runtime dependency. Supply its absolute path
through `tngBinary` or `--tng`. The Node package does not contain a Rust build
API, compiler command, source checkout, compatibility patch, or native binary;
installing and using it requires no Rust toolchain or Git.

The [native build workflow](../../.github/workflows/build-tng-client.yml) produces
a qualified Linux amd64 artifact with checksums and source/toolchain metadata.
Choose a successful run for a reviewed Nebula commit and verify the checksums
before installing the binary. Native source, patching and build instructions for
maintainers live under [`tools/tng-client`](../../tools/tng-client/README.md).
Native builds and releases can be maintained independently of the TypeScript API.

Keep the P-256 owner key on this trusted computer; only its public key belongs
in the measured deployment. Independently approve `expected-snp.json` with
`measurement` (96 lowercase hex digits), `initDataSha256` (64), `chipId` (128),
and `minimumReportedTcb` containing explicit `bootloader`, `tee`, `snp`, and
`microcode` byte values. Do not learn these values from the endpoint being verified.

```sh
nebula-trustee prepare --identity expected-snp.json --host trustee.example.test \
  --port 8443 --state /path/to/new/client-state
nebula-trustee verify --state /path/to/new/client-state \
  --tng /opt/tng/bin/tng \
  --owner-key /private/owner.key --audience trustee
```

Preparation is offline, refuses existing state, writes a private signing chain
and approved configuration, and removes the CA private key. Certificates last
two days. Use a new state directory to renew or change approval; connection
refuses expired certificates or edited policies/configuration. Optional
`--vcek public-vcek.der` uses AS's native offline endorsement store; AS still
validates the certificate chain and report signature. Otherwise AS uses its
native endorsement lookup.

## TypeScript API

```ts
import { readFileSync } from "node:fs";
import { prepareClient, TrusteeClient, trusteePolicies } from "@nebula/trustee-client";

// Run once, using an independently approved identity and fresh directory.
prepareClient({
  stateDirectory: "/private/trustee-client-state",
  identity: JSON.parse(readFileSync("expected-snp.json", "utf8")),
  target: { host: "trustee.example.test", port: 8443 },
});

const client = await TrusteeClient.connect({
  stateDirectory: "/private/trustee-client-state",
  tngBinary: "/opt/tng/bin/tng",
  ownerPrivateKey: readFileSync("/private/owner.key"),
  audience: "trustee", // deployment name, bound into its measured owner config
});
try {
  const recipient = JSON.parse(readFileSync("approved-recipient.json", "utf8"));
  const policies = trusteePolicies([{
    path: ["owner", "image-key", "release-1"], recipients: [recipient],
  }]);
  await client.setAttestationPolicy(policies.attestationPolicy); // default_cpu
  await client.setResourcePolicy(policies.resourcePolicy);
  await client.putResource(["owner", "image-key", "release-1"], readFileSync("resource.bin"));
  console.log(await client.listResourcePolicies());
} finally {
  await client.close();
}
```

`connect` resolves only after an attested, owner-authorized KBS request succeeds.
It cleans up on startup/verification failure. Always `close` a connected client;
it stops its own TNG and AS, cancels in-flight requests, and releases the state
lock. `signal` and `requestTimeoutMs` support caller cancellation and bounded
requests. The default request timeout is 30 seconds. `close` is idempotent.
Abrupt termination such as SIGKILL can leave `runtime.lock`; it records the PID
and unique Docker container name. Stop those owned processes before removing
a stale lock. Failed cleanup retains the lock and reports that recovery is needed.

Tokens are minted in memory per request with issuer `nebula-owner`, role `owner`,
the deployment audience, and a five-minute lifetime. The key and resource bytes
are never passed in subprocess arguments, mounted into the verifier, or logged.
HTTP proxy environment variables and redirects cannot reroute admin requests.
Requests go only through the managed loopback TNG listener; there is no raw-HTTP
fallback. Writes are not retried automatically. Requests and responses are
bounded to 2 MiB to match the deployment. A timeout on a write may mean that
Trustee applied it before the response was lost; reconcile before retrying.

## Commands

All connected commands take `--state`, `--tng`, `--owner-key`, and `--audience`.
They start, verify, and close a session automatically. Owner key files must be
private regular files (mode 0600).

| Command | Operation |
| --- | --- |
| `prepare` | Create private verifier state from approved identity; no server contact. |
| `verify` | Verify attested TLS and native owner authorization. |
| `list-resource-policies` | List installed resource policy IDs. |
| `put-resource <repository/type/tag> <file>` | Provision exact binary bytes. |
| `delete-resource <repository/type/tag>` | Delete a resource. |
| `set-resource-policy <file>` | Install reviewed resource-release Rego. |
| `set-attestation-policy <file>` | Install reviewed appraisal Rego; `--policy-id` defaults to `default_cpu`. |
| `owner-header <new-file>` | For manual integrations: write a private short-lived header without printing or overwriting it. |

The package also exports `tngTrusteeClientPlan`, `trusteePolicies`,
`createOwnerToken`, `TrusteeHttpError`, and their public types.
The native API formats follow [the qualified Trustee source](https://github.com/confidential-containers/trustee/blob/71251310045d8be2e95041cf0028691623c73957/tools/kbs-client/src/lib.rs).

Resource retrieval by a confidential workload uses CoCo's native KBS/CDH
protocol. This package implements owner administration; owner JWTs do not grant
attested recipient identity. It does not supply durable server identity,
singleton enforcement, rollback protection or continuous re-attestation.
See the deployment's full threat model and recorded SNP qualification.

## Tests

```sh
pnpm test
pnpm typecheck
TRUSTEE_TEST_IMAGE=ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68 \
TNG_TEST_BINARY=/absolute/path/to/qualified/tng pnpm test
```

Tests cover private preparation, exact approval, native JWT/HTTP encoding,
redirects, timeout/cancellation, failed startup, cleanup and installation into
a clean TypeScript consumer, including public API type checks and CLI invocation
outside a project directory. Tests and fixtures are TypeScript and run through
`tsx`, without generated JavaScript. The native KBS test checks administration with a test-only
loopback forwarding proxy; it makes no TEE claim. The native TNG/AS test verifies
that an ordinary TLS endpoint receives no owner request. Hardware evidence for
the shared TNG/AS approval path remains in the deployment's SNP test record.
