# @nebula/trustee-client

Node owner client for Nebula's [self-sufficient Trustee deployment](../nebula/src/modules/k8s/trustee/TNG.md).
Like `@nebula/cli`, this is a separate package with a command-line entry point.
It also exports a typed JavaScript API. The installed archive runs in plain Node;
it needs neither a repository checkout nor a TypeScript loader.

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

From the repository root, build with Node 24 and pnpm 11.9.0 and install its
archive (Node 20 development uses pnpm 10.34.6):

```sh
cd packages/trustee-client
pnpm install --frozen-lockfile
pnpm pack --pack-destination /tmp
npm install -g /tmp/nebula-trustee-client-0.1.0.tgz
nebula-trustee --help
```

For an application, install that same archive as a normal dependency instead of
globally. Packing builds the JavaScript and declarations and includes the native
TNG compatibility patch. The two pure policy/configuration sources are compiled
from `packages/nebula`, so deployment and client approval rules cannot drift into
separate implementations. There is no runtime dependency on cdk8s.

Build TNG explicitly; package installation never downloads or builds native code:

```sh
rustup toolchain install 1.98.1 --profile minimal
nebula-trustee build-tng /path/to/new/tng-source
```

This checks TNG v2.11.0's exact commit, applies the included mainline Trustee
compatibility patch, builds the client, and runs its certificate-encoding
regression test. `--toolchain stable` is supported when that installed toolchain
is Rust 1.98.1. See [upstream compatibility work](https://github.com/inclavare-containers/TNG/pull/263).

Keep the P-256 owner key on this trusted computer; only its public key belongs
in the measured deployment. Independently approve `expected-snp.json` with
`measurement` (96 lowercase hex digits), `initDataSha256` (64), `chipId` (128),
and `minimumReportedTcb` containing explicit `bootloader`, `tee`, `snp`, and
`microcode` byte values. Do not learn these values from the endpoint being verified.

```sh
nebula-trustee prepare --identity expected-snp.json --host trustee.example.test \
  --port 8443 --state /path/to/new/client-state
nebula-trustee verify --state /path/to/new/client-state \
  --tng /path/to/new/tng-source/target/release/tng \
  --owner-key /private/owner.key --audience trustee
```

Preparation is offline, refuses existing state, writes a private signing chain
and approved configuration, and removes the CA private key. Certificates last
two days. Use a new state directory to renew or change approval; connection
refuses expired certificates or edited policies/configuration. Optional
`--vcek public-vcek.der` uses AS's native offline endorsement store; AS still
validates the certificate chain and report signature. Otherwise AS uses its
native endorsement lookup.

## Node API

```js
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
| `build-tng <new-directory>` | Explicitly build the pinned native client. |
| `verify` | Verify attested TLS and native owner authorization. |
| `list-resource-policies` | List installed resource policy IDs. |
| `put-resource <repository/type/tag> <file>` | Provision exact binary bytes. |
| `delete-resource <repository/type/tag>` | Delete a resource. |
| `set-resource-policy <file>` | Install reviewed resource-release Rego. |
| `set-attestation-policy <file>` | Install reviewed appraisal Rego; `--policy-id` defaults to `default_cpu`. |
| `owner-header <new-file>` | For manual integrations: write a private short-lived header without printing or overwriting it. |

The package also exports `tngTrusteeClientPlan`, `trusteePolicies`,
`createOwnerToken`, `buildTngClient`, `TrusteeHttpError`, and their public types.
The native API formats follow [the qualified Trustee source](https://github.com/confidential-containers/trustee/blob/71251310045d8be2e95041cf0028691623c73957/tools/kbs-client/src/lib.rs).

Resource retrieval by a confidential workload uses CoCo's native KBS/CDH
protocol. This package implements owner administration; owner JWTs do not grant
attested recipient identity. It does not supply durable server identity,
singleton enforcement, rollback protection or continuous re-attestation.
See the deployment's full threat model and recorded SNP qualification.

## Tests

```sh
pnpm test
TRUSTEE_TEST_IMAGE=ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68 \
TNG_TEST_BINARY=/absolute/path/to/qualified/tng pnpm test
```

Tests cover private preparation, exact approval, native JWT/HTTP encoding,
redirects, timeout/cancellation, failed startup, cleanup and installation into
a clean consumer. The native KBS test checks administration with a test-only
loopback forwarding proxy; it makes no TEE claim. The native TNG/AS test verifies
that an ordinary TLS endpoint receives no owner request. Hardware evidence for
the shared TNG/AS approval path remains in the deployment's SNP test record.
