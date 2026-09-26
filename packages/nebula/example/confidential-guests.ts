/**
 * Confidential guests example: two measured guests on one confidential node,
 * each created and recovered by its own lifecycle controller, with their
 * signed releases, admission fence, Services, log retention, attested pull
 * broker, sealed disks and key injector, in one ConfidentialGuestStack.
 *
 * - `primary` runs a workload and can boot a second copy of its release
 *   beside the serving one (the stage boot) to hand its sealed disk over.
 * - `operator` is an operator guest that reaches the primary's control port.
 *
 * Every name, address, domain and image below is an example value. The
 * templates' init-data and hashes stand in for what policy generation
 * records; generate the real ones from your own templates.
 *
 *   cdk8s synth --app 'tsx example/confidential-guests.ts'
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App, Chart } from "cdk8s";
import type { Construct } from "constructs";
import {
  ConfidentialGuestStack,
  LIFECYCLE_CLAIM_PLACEHOLDER,
  NEUTRAL_SEALED_STORAGE,
  NEUTRAL_WIRE,
  NEUTRAL_WORKLOAD_API,
  adapterModeEnv,
  digestImage,
  guestEnv,
  lifecycleLabelKey,
  measuredGuest,
  sealedStorageEnv,
  type DsseEnvelope,
  type GuestDeploymentEnv,
  type GuestPodManifest,
} from "../src/modules/k8s";

const namespace = "guests";
const nodeName = "tee-node-1";
const runtimeClassName = "kata-qemu-snp";
const labelDomain = "guests.example.com";
const authority = "5eed5eed5eed5eed";
const releaseConfigMap = `signed-release-${authority}`;
const pullSecret = "registry-pull";
const MiB = 1024 ** 2, GiB = 1024 ** 3, TiB = 1024 ** 4;

const images = {
  storage: digestImage(`ghcr.io/example/confidential-guests-storage@sha256:${"1".repeat(64)}`),
  attest: digestImage(`ghcr.io/example/confidential-guests-attest@sha256:${"2".repeat(64)}`),
  app: digestImage(`ghcr.io/example/workload@sha256:${"3".repeat(64)}`),
  console: digestImage(`ghcr.io/example/console@sha256:${"4".repeat(64)}`),
  control: digestImage(`ghcr.io/example/confidential-guests-control@sha256:${"5".repeat(64)}`),
  tools: digestImage(`ghcr.io/example/confidential-guests-tools@sha256:${"6".repeat(64)}`),
  injector: digestImage(`ghcr.io/example/confidential-guests-injector@sha256:${"7".repeat(64)}`),
  kbs: digestImage(`ghcr.io/example/kbs@sha256:${"8".repeat(64)}`),
};

// The deployment's measured env (the guest env contract): the neutral wire
// names with this deployment's release scope and roles, its sealed volumes
// and the neutral adapter's API. The primary guest seals the `chain` volume,
// the operator guest the `workspace` volume; each Pod names its own workload.
export const EXAMPLE_GUEST_DEPLOYMENT: GuestDeploymentEnv = {
  wire: {
    ...NEUTRAL_WIRE,
    releaseSet: { scope: { emit: "deployment=example" }, roles: ["node", "operator"] },
    workloadRef: "example/workload:v1",
  },
  storageLayout: {
    chain: { node: "sealed-data", volume: "data-v1", bytes: TiB, map: "guest-data", mount: "/run/volume/data" },
    workspace: { node: "sealed-workspace", volume: "workspace-v1", bytes: GiB, map: "guest-workspace", mount: "/run/volume/workspace" },
    kdf: NEUTRAL_SEALED_STORAGE.kdf,
    lifecycleKey: { mask: 0x9, tcb: "0000000000000000" },
    secrets: { file: "guest-secrets-v1", formats: [NEUTRAL_SEALED_STORAGE.recordFormat], identityExports: ["identity-a", "identity-b"], jwtExport: "shared-secret" },
  },
  workloadApi: NEUTRAL_WORKLOAD_API,
};
const deploymentFor = (workloadRef: string): GuestDeploymentEnv =>
  ({ ...EXAMPLE_GUEST_DEPLOYMENT, wire: { ...EXAMPLE_GUEST_DEPLOYMENT.wire, workloadRef } });

const guestLabels = { app: "guests" };
const primaryLabels = { ...guestLabels, role: "primary" };
const operatorLabels = { ...guestLabels, role: "operator" };
const restricted = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
const memory = (name: string) => ({ name, emptyDir: { medium: "Memory", sizeLimit: "16Mi" } });
const probe = (path: string, port: number) => ({ httpGet: { path, port }, periodSeconds: 5 });

// The attestation adapter in every guest: it verifies the signed releases
// mounted at /release and reads the deployment's env.
const attest = (workloadRef: string) => ({
  name: "attest", image: images.attest, securityContext: restricted,
  env: [...guestEnv(deploymentFor(workloadRef)), adapterModeEnv(NEUTRAL_WORKLOAD_API),
    { name: "RELEASE_SET_PATH", value: "/release/release-set.dsse.json" }],
  readinessProbe: probe("/livez", 8081),
  volumeMounts: [{ name: "release", mountPath: "/release", readOnly: true }, { name: "run", mountPath: "/run/guest-attest" }],
});
// Sealed storage opens the guest's volume with the adapter's layout.
const storage = (volume: "chain" | "workspace") => ({
  name: "storage", image: images.storage, args: ["serve"],
  env: sealedStorageEnv(EXAMPLE_GUEST_DEPLOYMENT.storageLayout, volume),
  securityContext: { ...restricted, capabilities: { drop: ["ALL"], add: ["SYS_ADMIN", "MKNOD"] } },
  volumeDevices: [{ name: "data", devicePath: "/dev/guest-data" }],
  volumeMounts: [{ name: "run", mountPath: "/run/guest-attest" }],
});

function guest(name: string, labels: Record<string, string>, grace: number, claim: string, containers: object[],
  [volume, workloadRef]: ["chain" | "workspace", string]): GuestPodManifest {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name, namespace, labels, annotations: { "io.katacontainers.config.hypervisor.default_vcpus": "2" } },
    spec: {
      runtimeClassName, nodeName, restartPolicy: "Never", terminationGracePeriodSeconds: grace,
      automountServiceAccountToken: false, enableServiceLinks: false,
      initContainers: [{ name: "initialize", image: images.storage, args: ["install"], securityContext: restricted }],
      containers: [storage(volume), attest(workloadRef), ...containers],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: claim } },
        memory("run"),
        { name: "release", configMap: { name: releaseConfigMap } },
      ],
    },
  };
}

// The primary release runs as holder and as stage boot, so its template names
// the claim placeholder; the controller substitutes the phase's claim.
const primary = guest("guest-primary", primaryLabels, 120, LIFECYCLE_CLAIM_PLACEHOLDER, [
  { name: "workload", image: images.app, securityContext: restricted, readinessProbe: probe("/readyz", 8080),
    ports: [{ name: "control", containerPort: 7443 }] },
], ["chain", EXAMPLE_GUEST_DEPLOYMENT.wire.workloadRef]);
const operator = guest("guest-operator", operatorLabels, 60, "guest-operator-v1", [
  { name: "console", image: images.console, securityContext: restricted, ports: [{ name: "ssh", containerPort: 2222 }] },
], ["workspace", "example/console:v1"]);

// What policy generation records for each template.
const artifacts = {
  primary: {
    canonicalPodSha256: "f3b1aca39e8e9a9a4a16743b8682cab83bef3c1b586f08bcaab1fd38850e45d9",
    ccInitData: "H4sIAAAAAAACEzXNzQoCMQwE4HufYoj3sqIHEXwSFQlraIv9I1vUfXtbFg+5zDdD3qJLKBkX0GT3diLD0RUNzaeRLZ4PpyOZ65Mb3w3VEsO8WhVXaHjl+cVO0C+3x6a3vIN8OdUoqBoS64pNzug1UW6C5gUqHFGy4NPfDfrvyfwAvYvV15cAAAA=",
    initDataSha256: "cf0a41d3ef41f212a569890cc7e654d53c5b14c2cb6951e69b56563016b3c841",
  },
  operator: {
    canonicalPodSha256: "87af2b8de239680ef437602b6a8f9b8b58d31deaea0ea4744fb24517766c2d1a",
    ccInitData: "H4sIAAAAAAAAEzWNwQrCMBBE7/mKYb2Xih5E8EtUZKlLEkyzYRuq/r0JxcNc3htmVrElasYFNA77YSTHyavFGubOlsCH05Hc9cmV746Kpjh9BxOv1H3h6cVe0JLrY7O3vIN8eC5JoEWMqxo2dUbrdSKoQWDCCZoF7/bX1X+A3A8iytXgmAAAAA==",
    initDataSha256: "e47e5deb9d53cf9c67f88b97c0e58921ae65f27b86be21c418acbbeb5397519c",
  },
};

// Signed by the release authority with your release tooling; the example
// carries the statements without signatures.
const statement = (payloadType: string, payload: object): DsseEnvelope =>
  ({ payloadType, payload: Buffer.from(JSON.stringify(payload)).toString("base64"), signatures: [] });
const expires = 1893456000;

/** The KBS configuration the pull broker runs with (supplied by the caller). */
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

export function confidentialGuestsExample(scope: Construct): ConfidentialGuestStack {
  const lifecycleLabel = lifecycleLabelKey(labelDomain);
  const bind = (pod: string) => [{ pod, container: "storage" }, { pod, container: "attest" }];
  return new ConfidentialGuestStack(scope, "guests", {
    namespace, nodeName, runtimeClassName, labelDomain,
    // Pull credentials are released only to guests whose measured init-data
    // is one of the declared releases (the stack admits exactly those).
    pullBroker: {
      name: "pull-broker",
      configMapName: "pull-broker-configuration",
      networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
      podLabels: { app: `${namespace}-pull-broker` },
      guestSelector: guestLabels,
      brokerImage: images.kbs,
      initImage: images.tools,
      initCommand: ["python3", "-m", "confidential_guests.registry_init"],
      configToml: EXAMPLE_BROKER_CONFIG,
      resourcePath: ["default", "registry", "pull"],
      pullSecret: { name: pullSecret, exposeAsResource: true },
      imagePullSecrets: [pullSecret],
    },
    releases: {
      payloadTypes: { neutral: { release: NEUTRAL_WIRE.payloadTypes.release.emit, releaseSet: NEUTRAL_WIRE.payloadTypes.releaseSet.emit } },
      releaseSet: true, reading: [authority],
      authorities: [{ fingerprint: authority, status: "active", formats: [{ format: "neutral", configMap: releaseConfigMap, envelopes: {
        release: statement(NEUTRAL_WIRE.payloadTypes.release.emit, { deployment: "example", expires_at: expires }),
        releaseSet: statement(NEUTRAL_WIRE.payloadTypes.releaseSet.emit, { deployment: "example", sequence: 1, expires_at: expires,
          members: [artifacts.primary.initDataSha256, artifacts.operator.initDataSha256] }),
      } }] }],
    },
    services: {
      ingress: [
        // The operator guest may reach the primary's control port.
        { name: "primary-control", podSelector: primaryLabels, ports: [7443], from: [operatorLabels] },
        // A stage boot reaches only the holder's handoff listener.
        { name: "primary-handoff", podSelector: { ...primaryLabels, [lifecycleLabel]: "holder" }, ports: [7445],
          from: [{ ...primaryLabels, [lifecycleLabel]: "stage" }] },
        { name: "operator-ssh", podSelector: operatorLabels, ports: [2222] },
      ],
      services: [
        // The stage boot shares the primary's labels; only the holder serves.
        { name: "guest-primary", selector: { ...primaryLabels, [lifecycleLabel]: "holder" }, ports: [7443, 7445], publishNotReadyAddresses: true },
        { name: "guest-operator", selector: operatorLabels, ports: [2222] },
      ],
    },
    // Loop-file block disks for the guests' claims: the primary's data disk
    // (its previous, smaller generation retained for a revert, an older one
    // declared once more before it leaves), the stage placeholder the stage
    // boot starts on, and the operator's workspace. SealedDisks also renders
    // the key injector, which hands the key device to the guests' storage and
    // attestation containers.
    disks: {
      image: images.tools,
      stateDir: "/var/lib/guests/disks",
      imagePullSecrets: [pullSecret],
      roles: [
        { role: "primary", claim: "guest-primary-data", file: "primary-data", sizeBytes: TiB, sizeLabel: "1Ti", provisioner: "primary-disk" },
        { role: "standby", claim: "guest-primary-stage", file: "primary-stage", sizeBytes: 16 * MiB, sizeLabel: "16Mi", provisioner: "standby-disk",
          placeholder: true },
        { role: "operator", claim: "guest-operator", file: "operator", sizeBytes: GiB, sizeLabel: "1Gi", provisioner: "operator-disk" },
      ],
      placeholderMagic: "example.placeholder/v1\n",
      table: {
        live: { primary: { generation: 3, loop: 203 }, standby: { generation: 1, loop: 210 }, operator: { generation: 1, loop: 220 } },
        retained: [{ role: "primary", generation: 2, loop: 202, sizeBytes: 64 * GiB, sizeLabel: "64Gi" }],
        retired: [{ role: "primary", generation: 1, loop: 201, declared: true, sizeBytes: 64 * GiB, sizeLabel: "64Gi" }],
        reservedLoops: [199],
        protectedLoops: [199],
        firstPinnedLoop: 100,
      },
      injector: {
        name: "key-injector",
        image: images.injector,
        imagePullSecrets: [pullSecret],
        pluginIndex: "40",
        runtimeHandler: runtimeClassName,
        device: { major: 10, minor: 258 },
        bindings: [...bind("guest-primary"), ...bind("guest-primary-stage"), ...bind("guest-operator")],
      },
    },
    logRetention: { hostPath: "/var/lib/guests/logs", collector: { image: images.tools } },
    fence: {
      policyNames: { creator: "guests-creator", shape: "guests-shape" },
      guestClaimPrefix: "guest-",
      messages: {
        creator: "only the lifecycle controllers create guest Pods",
        name: "guest name outside the controller's role",
        placement: "guest must run on the confidential node and runtime class with restartPolicy Never",
        hostNamespaces: "guest must not share host or process namespaces",
        serviceAccount: "guest must run as the default ServiceAccount without a token",
        volumes: "guest volumes are limited to configMap, emptyDir and persistentVolumeClaim",
        claim: "guest mounts exactly one claim, named data, of its own role",
        privilege: "guest containers must not be privileged or escalate",
        initData: "guest must carry init-data and no Argo tracking-id",
      },
    },
    lifecycle: {
      controller: { image: images.control },
      budget: { epoch: 1, limit: 3 }, startupSeconds: 900,
      rollout: { limit: 3, stageSeconds: 600, backoffSeconds: 120, settleSeconds: 30 },
      roles: [
        {
          role: "primary", holder: "guest-primary", claim: "guest-primary-data-v3", generation: 3, graceSeconds: 120,
          live: ["attest", "/livez", 8081], ready: ["workload", "/readyz", 8080],
          releases: { "primary-v1": measuredGuest(primary, artifacts.primary) }, current: "primary-v1",
          stage: { name: "guest-primary-stage", claim: "guest-primary-stage-v1", containers: ["storage", "attest"] },
        },
        {
          role: "operator", holder: "guest-operator", claim: "guest-operator-v1", generation: 1, graceSeconds: 60,
          live: ["attest", "/livez", 8081], ready: ["attest", "/livez", 8081],
          releases: { "operator-v1": measuredGuest(operator, artifacts.operator) }, current: "operator-v1",
        },
      ],
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = new App();
  confidentialGuestsExample(new Chart(app, "confidential-guests-example"));
  app.synth();
}
