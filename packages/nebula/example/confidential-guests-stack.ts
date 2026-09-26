/**
 * Confidential guest stack example: two measured guests on one confidential
 * node, each created and recovered by its own lifecycle controller, with
 * their signed releases, admission fence, Services and log retention.
 *
 * - `primary` runs a workload and can boot a second copy of its release
 *   beside the serving one (the stage boot) to hand its sealed disk over.
 * - `operator` is an operator guest that reaches the primary's control port.
 *
 * Every name, address, domain and image below is an example value. The
 * templates' init-data and hashes stand in for what policy generation
 * records; generate the real ones from your own templates.
 *
 *   cdk8s synth --app 'tsx example/confidential-guests-stack.ts'
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ConfidentialGuestStack,
  LIFECYCLE_CLAIM_PLACEHOLDER,
  NEUTRAL_WIRE,
  digestImage,
  lifecycleLabelKey,
  measuredGuest,
  wireProfileEnv,
  type DsseEnvelope,
  type GuestPodManifest,
} from "../src/modules/k8s";

const namespace = "guests";
const nodeName = "tee-node-1";
const runtimeClassName = "kata-qemu-snp";
const labelDomain = "guests.example.com";
const authority = "5eed5eed5eed5eed";
const releaseConfigMap = `signed-release-${authority}`;

const images = {
  storage: digestImage(`ghcr.io/example/confidential-guests-storage@sha256:${"1".repeat(64)}`),
  attest: digestImage(`ghcr.io/example/confidential-guests-attest@sha256:${"2".repeat(64)}`),
  app: digestImage(`ghcr.io/example/workload@sha256:${"3".repeat(64)}`),
  console: digestImage(`ghcr.io/example/console@sha256:${"4".repeat(64)}`),
  control: digestImage(`ghcr.io/example/confidential-guests-control@sha256:${"5".repeat(64)}`),
  tools: digestImage(`ghcr.io/example/confidential-guests-tools@sha256:${"6".repeat(64)}`),
};

const guestLabels = { app: "guests" };
const primaryLabels = { ...guestLabels, role: "primary" };
const operatorLabels = { ...guestLabels, role: "operator" };
const restricted = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
const memory = (name: string) => ({ name, emptyDir: { medium: "Memory", sizeLimit: "16Mi" } });
const probe = (path: string, port: number) => ({ httpGet: { path, port }, periodSeconds: 5 });

// The attestation agent in every guest: it verifies the signed releases
// mounted at /release and speaks the neutral wire names.
const attest = {
  name: "attest", image: images.attest, securityContext: restricted,
  env: [wireProfileEnv(NEUTRAL_WIRE), { name: "RELEASE_SET_PATH", value: "/release/release-set.dsse.json" }],
  readinessProbe: probe("/livez", 8081),
  volumeMounts: [{ name: "release", mountPath: "/release", readOnly: true }, { name: "run", mountPath: "/run/guest-attest" }],
};
const storage = {
  name: "storage", image: images.storage, args: ["serve"],
  securityContext: { ...restricted, capabilities: { drop: ["ALL"], add: ["SYS_ADMIN", "MKNOD"] } },
  volumeDevices: [{ name: "data", devicePath: "/dev/guest-data" }],
  volumeMounts: [{ name: "run", mountPath: "/run/guest-attest" }],
};

function guest(name: string, labels: Record<string, string>, grace: number, claim: string, containers: object[]): GuestPodManifest {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name, namespace, labels, annotations: { "io.katacontainers.config.hypervisor.default_vcpus": "2" } },
    spec: {
      runtimeClassName, nodeName, restartPolicy: "Never", terminationGracePeriodSeconds: grace,
      automountServiceAccountToken: false, enableServiceLinks: false,
      initContainers: [{ name: "initialize", image: images.storage, args: ["install"], securityContext: restricted }],
      containers: [storage, attest, ...containers],
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
]);
const operator = guest("guest-operator", operatorLabels, 60, "guest-operator-v1", [
  { name: "console", image: images.console, securityContext: restricted, ports: [{ name: "ssh", containerPort: 2222 }] },
]);

// What policy generation records for each template.
const artifacts = {
  primary: {
    canonicalPodSha256: "fe7ed907d33de147163e84b2f17334e2bbbd2fa1e9dfe712ba2b2694220c72b0",
    ccInitData: "H4sIAAAAAAACEzXNzQoCMQwE4HufYoj3sqIHEXwSFQlraIv9I1vUfXtbFg+5zDdD3qJLKBkX0GT3diLD0RUNzaeRLZ4PpyOZ65Mb3w3VEsO8WhVXaHjl+cVO0C+3x6a3vIN8OdUoqBoS64pNzug1UW6C5gUqHFGy4NPfDfrvyfwAvYvV15cAAAA=",
    initDataSha256: "cf0a41d3ef41f212a569890cc7e654d53c5b14c2cb6951e69b56563016b3c841",
  },
  operator: {
    canonicalPodSha256: "f0aa0e313817c5d02095e635674ee7b083b61e423a03f27d3bb551ed8a6c02de",
    ccInitData: "H4sIAAAAAAAAEzWNwQrCMBBE7/mKYb2Xih5E8EtUZKlLEkyzYRuq/r0JxcNc3htmVrElasYFNA77YSTHyavFGubOlsCH05Hc9cmV746Kpjh9BxOv1H3h6cVe0JLrY7O3vIN8eC5JoEWMqxo2dUbrdSKoQWDCCZoF7/bX1X+A3A8iytXgmAAAAA==",
    initDataSha256: "e47e5deb9d53cf9c67f88b97c0e58921ae65f27b86be21c418acbbeb5397519c",
  },
};

// Signed by the release authority with your release tooling; the example
// carries the statements without signatures.
const statement = (payloadType: string, payload: object): DsseEnvelope =>
  ({ payloadType, payload: Buffer.from(JSON.stringify(payload)).toString("base64"), signatures: [] });
const expires = 1893456000;

export function confidentialGuestStackExample(scope: Construct): ConfidentialGuestStack {
  const lifecycleLabel = lifecycleLabelKey(labelDomain);
  return new ConfidentialGuestStack(scope, "guests", {
    namespace, nodeName, runtimeClassName, labelDomain,
    releases: {
      payloadTypes: { neutral: { release: NEUTRAL_WIRE.payloadTypes.release.emit, releaseSet: NEUTRAL_WIRE.payloadTypes.releaseSet.emit } },
      releaseSet: true, reading: [authority],
      authorities: [{ fingerprint: authority, status: "active", formats: [{ format: "neutral", configMap: releaseConfigMap, envelopes: {
        release: statement(NEUTRAL_WIRE.payloadTypes.release.emit, { deployment: "example-v1", expires_at: expires }),
        releaseSet: statement(NEUTRAL_WIRE.payloadTypes.releaseSet.emit, { deployment: "example-v1", sequence: 1, expires_at: expires,
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
          role: "primary", holder: "guest-primary", claim: "guest-primary-data-v1", generation: 1, graceSeconds: 120,
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
    // The pull broker, sealed disks and key injector plug in here and receive
    // the guests' Pod names, claims and HOST_DATA:
    //   pullBroker: (scope, context) => { ... context.initDataSha256 ... },
    //   disks: (scope, context) => { ... context.roles ... },
    //   keyInjector: (scope, context) => { ... context.guestPods ... },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = new App();
  const chart = new Chart(app, "confidential-guests-stack");
  confidentialGuestStackExample(chart);
  app.synth();
}
