/** Complete declaration example. Replace the public pins and invitation hash
 * with independently reviewed values before applying its synthesized YAML.
 * No private key, image key or registry password belongs in this file.
 *
 *   pnpm exec cdk8s synth --app 'tsx example/confidential-workload-stack.ts'
 */
import { App, Chart, ApiObject } from "cdk8s";
import { SealedDisks } from "../src/modules/k8s/confidential-guests/sealed-disks";
import { ConfidentialOperator, ConfidentialStorage, ConfidentialStorageDevices,
  ConfidentialWorkload, type ConfidentialStorageResource } from "../src/modules/k8s/confidential-workloads";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";

const namespace = "confidential-example";
const node = "replace-with-snp-node";
const profile = "example-workload";
const images = {
  operator: "ghcr.io/example/confidential-operator@sha256:" + "1".repeat(64),
  injector: "ghcr.io/example/confidential-storage-devices@sha256:" + "2".repeat(64),
  storage: "ghcr.io/example/confidential-storage@sha256:" + "3".repeat(64),
  gateway: "ghcr.io/example/confidential-runtime@sha256:" + "4".repeat(64),
  kbs: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
  tng: "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416",
  disks: "ghcr.io/example/disktools@sha256:" + "5".repeat(64),
};
const app = new App(), chart = new Chart(app, "confidential-workload-stack");
new ApiObject(chart, "namespace", { apiVersion: "v1", kind: "Namespace", metadata: {
  name: namespace, annotations: { "argocd.argoproj.io/sync-wave": "-6",
    "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" },
} });
new ConfidentialOperator(chart, "operator", { namespace, image: images.operator, watchNamespaces: [namespace] });
new SealedDisks(chart, "ciphertext-disk", {
  namespace, nodeName: node, image: images.disks,
  stateDir: "/var/lib/confidential-example", roles: [{ role: "data", claim: "example-data",
    file: "data", sizeBytes: 1073741824, sizeLabel: "1Gi", provisioner: "example-data" }],
  table: { live: { data: { generation: 1, loop: 240 } }, retained: [], retired: [],
    reservedLoops: [], protectedLoops: [], firstPinnedLoop: 240 },
});
new ConfidentialStorageDevices(chart, "devices", { name: "example-devices", namespace,
  nodeName: node, image: images.injector, pluginIndex: "64", bindings: [{ profile, storage: "data" }] });
const storages: ConfidentialStorageResource[] = [{ apiVersion: "confidential.nebula.dev/v1alpha1",
  kind: "ConfidentialStorage", metadata: { name: "data", namespace }, spec: {
    type: "EncryptedBlock", claimName: "example-data-v1", sizeBytes: 1073741824,
    keyResource: ["default", "volume", "data"], initialization: "IfEmpty", retention: "Retain",
  } }, { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
  metadata: { name: "scratch", namespace }, spec: { type: "Memory", sizeLimit: "32Mi" } }];
for (const storage of storages) new ConfidentialStorage(chart, storage.metadata.name,
  { name: storage.metadata.name, namespace, spec: storage.spec });
new ConfidentialWorkload(chart, "workload", { name: "workload", namespace, storages, spec: {
  profile, ownerClaimSha256: "6".repeat(64),
  guest: { measurement: "7".repeat(96), chipId: "8".repeat(128),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
  nodeSelector: { "kubernetes.io/hostname": node },
  network: { ipv4AddressPattern: "^10[.]244[.][0-9]{1,3}[.][0-9]{1,3}$",
    ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
  trustee: { chart: TRUSTEE_CHART, version: "0.21.0", kbsImage: images.kbs,
    tngImage: images.tng, gatewayImage: images.gateway },
  storageImage: images.storage,
  containers: [{ name: "app", image: "ghcr.io/example/workload:owner-release-1",
    imageKeyResource: ["default", "image", "app"], command: ["/app/server"], uid: 11000, gid: 11000,
    mounts: [{ storage: "data", path: "/data" }, { storage: "scratch", path: "/scratch" }],
    ports: [{ name: "app", port: 9080 }] }],
  storage: [{ name: "data", resource: "data" }, { name: "scratch", resource: "scratch" }],
  resources: [["default", "image", "app"], ["default", "volume", "data"]],
  runtime: { memoryMiB: 4096, vcpus: 2, k8sDistribution: "k0s", ociVersion: "1.3.0" },
} });
// Route only raw TCP to the Service created by the operator. Select a Gateway
// implementation and public address supported by the target cluster.
new ApiObject(chart, "owner-gateway", { apiVersion: "gateway.networking.k8s.io/v1", kind: "Gateway",
  metadata: { name: "example-owner", namespace }, spec: { gatewayClassName: "replace-with-gateway-class",
    listeners: [{ name: "owner", protocol: "TLS", port: 8443, tls: { mode: "Passthrough" } }] } });
new ApiObject(chart, "owner-route", { apiVersion: "gateway.networking.k8s.io/v1alpha2", kind: "TLSRoute",
  metadata: { name: "example-owner", namespace }, spec: { parentRefs: [{ name: "example-owner", sectionName: "owner" }],
    hostnames: ["owner.example.test"], rules: [{ backendRefs: [{ name: "workload-owner", port: 8443 }] }] } });
app.synth();
