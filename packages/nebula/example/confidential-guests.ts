/**
 * Confidential guests example: the host-side storage and pull machinery for
 * two guest roles (a node and its maintenance guest) on one host.
 *
 *   cdk8s synth --app 'tsx example/confidential-guests.ts'
 *
 * Every name, address, image, path and the label domain is the caller's; the
 * values here are placeholders under example.com.
 */
import { App, Chart } from "cdk8s";
import type { Construct } from "constructs";
import { pathToFileURL } from "node:url";
import { AttestedPullBroker, SealedDisks, sha256Hex } from "../src/modules/k8s/confidential-guests";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const image = (name: string, digit: string) => `registry.example.com/guests/${name}@sha256:${digit.repeat(64)}`;

/** The KBS configuration the broker runs with (supplied by the caller). */
export const EXAMPLE_BROKER_CONFIG = `[http_server]
insecure_http = true
sockets = ["0.0.0.0:8080"]

[attestation_token]
insecure_header_jwk = false
trusted_certs_paths = ["/state/issuer/cert.pem"]

[attestation_service]
type = "coco_as_builtin"

[attestation_service.attestation_token_broker]
duration_min = 5

[attestation_service.attestation_token_broker.signer]
key_path = "/state/issuer/key.pem"
cert_path = "/state/issuer/cert.pem"

[attestation_service.rvps_config]
type = "BuiltIn"

[attestation_service.verifier_config.snp_verifier]
vcek_sources = [{ type = "KDS" }]

[admin]
authorization_mode = "DenyAll"

[storage_backend]
storage_type = "LocalFs"
[storage_backend.backends.local_fs]
dir_path = "/state"

[[plugins]]
name = "resource"
storage_backend_type = "kvstorage"
`;

export class ConfidentialGuestsExample extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const namespace = "confidential-guests";
    const nodeName = "guest-host-1";
    const pullSecret = "registry-pull";

    // Pull credentials are released only to guests whose measured init-data
    // is one of the two reviewed releases.
    new AttestedPullBroker(this, "pull-broker", {
      namespace,
      name: "pull-broker",
      configMapName: "pull-broker-configuration",
      networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
      podLabels: { app: `${namespace}-pull-broker` },
      guestSelector: { app: "confidential-guest" },
      nodeName,
      brokerImage: image("kbs", "a"),
      initImage: image("tools", "b"),
      initCommand: ["python3", "-m", "confidential_guests.registry_init"],
      configToml: EXAMPLE_BROKER_CONFIG,
      resourcePath: ["default", "registry", "pull"],
      initData: { form: "in", values: [sha256Hex("example node release"), sha256Hex("example maintenance release")] },
      pullSecret: { name: pullSecret, exposeAsResource: true },
      labelDomain: "guests.example.com",
      imagePullSecrets: [pullSecret],
    });

    // One data disk for the node, a workspace for the maintenance guest and a
    // stage placeholder the next node release boots on during a handoff. The
    // node's previous generation is retained for a revert, an older one is
    // declared once more before it leaves, and the oldest has left: its minor
    // stays held.
    new SealedDisks(this, "disks", {
      namespace,
      nodeName,
      image: image("storage", "c"),
      stateDir: `/var/lib/${namespace}`,
      imagePullSecrets: [pullSecret],
      roles: [
        { role: "node", claim: "node-data", file: "data", sizeBytes: 64 * GiB, sizeLabel: "64Gi", provisioner: "data-provisioner" },
        { role: "maintenance", claim: "maintenance-workspace", file: "workspace", sizeBytes: GiB, sizeLabel: "1Gi", provisioner: "workspace-provisioner" },
        { role: "stage", claim: "node-stage", file: "stage", sizeBytes: 16 * MiB, sizeLabel: "16Mi", provisioner: "stage-provisioner", placeholder: true },
      ],
      placeholderMagic: "EXAMPLE-STAGE-PLACEHOLDER-V1\n",
      table: {
        live: { node: { generation: 3, loop: 203 }, maintenance: { generation: 1, loop: 210 }, stage: { generation: 1, loop: 220 } },
        retained: [{ role: "node", generation: 2, loop: 202 }],
        retired: [{ role: "node", generation: 1, loop: 201, declared: true }],
        reservedLoops: [199],
        protectedLoops: [199],
        firstPinnedLoop: 100,
      },
      injector: {
        name: "key-injector",
        image: image("key-injector", "d"),
        imagePullSecrets: [pullSecret],
        pluginIndex: "90",
        runtimeHandler: "kata-qemu-snp",
        device: { major: 10, minor: 258 },
        bindings: [
          { pod: "node", container: "storage" },
          { pod: "node", container: "attest" },
          { pod: "maintenance", container: "storage" },
          { pod: "maintenance", container: "attest" },
        ],
      },
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = new App();
  new ConfidentialGuestsExample(app, "confidential-guests-example");
  app.synth();
}
