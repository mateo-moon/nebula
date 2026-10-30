/** Complete declaration example. Replace public pins and host configuration
 * with independently reviewed values before applying its synthesized YAML.
 * No private key, image key or registry password belongs in this file.
 *
 *   pnpm exec cdk8s synth --app 'tsx example/confidential-workload-stack.ts'
 *
 * Set CONFIDENTIAL_BROWSER_IMAGE to a reviewed digest-pinned preparation
 * image to enable the browser flow. To serve its first page from a TEE, also
 * set CONFIDENTIAL_BROWSER_TLS_IMAGE and CONFIDENTIAL_BROWSER_TLS_TNG_IMAGE
 * to the reviewed frontend and HTTP/1.1-capable TNG images. The user checks
 * the browser certificate before entering the separately supplied token.
 */
import { App, Chart, ApiObject } from "cdk8s";
import { SealedDisks } from "../src/modules/k8s/confidential-guests/sealed-disks";
import { ConfidentialBrowser, ConfidentialOperator, ConfidentialStorage, ConfidentialStorageDevices,
  ConfidentialWorkload, type ConfidentialStorageResource } from "../src/modules/k8s/confidential-workloads";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";

const namespace = "confidential-example";
const node = "replace-with-snp-node";
const profile = "example-workload";
const browserImage = process.env.CONFIDENTIAL_BROWSER_IMAGE;
const frontendImage = process.env.CONFIDENTIAL_BROWSER_TLS_IMAGE;
const frontendTngImage = process.env.CONFIDENTIAL_BROWSER_TLS_TNG_IMAGE;
const frontendUrl = process.env.CONFIDENTIAL_BROWSER_TLS_ENDPOINT ?? "https://192.0.2.10:9443/";
if (frontendImage && (!browserImage || !frontendTngImage)) throw new Error("Manual TLS also needs reviewed preparation and HTTP/1.1 TNG images");
const nodeSelector = { "kubernetes.io/hostname": node };
const network = { ipv4AddressPattern: "^10[.]244[.][0-9]{1,3}[.][0-9]{1,3}$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" };
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
new ConfidentialOperator(chart, "operator", { namespace, image: images.operator, watchNamespaces: [namespace],
  accessLinkSecrets: [{ namespace, name: "workload-access" }] });
if (browserImage) new ConfidentialBrowser(chart, "preparation", { name: "example-preparation", namespace,
  image: browserImage, tngImage: images.tng, nodeSelector, network });
if (frontendImage) new ConfidentialBrowser(chart, "browser-ui", { name: "example-browser-ui", namespace,
  image: frontendImage, tngImage: frontendTngImage!, nodeSelector, network,
  manualTls: { preparationEndpoint: "https://preparation.example.test/", stackEndpoint: "https://owner.example.test/" } });
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
  profile, ...(browserImage ? { browserOwner: true as const } : {}),
  accessLink: { url: "https://owner.example.test/", ownerPort: 8443, secretName: "workload-access",
    ...(browserImage ? { browser: {
      invitationEndpoint: `http://example-preparation-invitation.${namespace}.svc:8089/invitation`,
      workloadEndpoint: "https://preparation.example.test/", ownerEndpoint: "https://workload.example.test/",
      loaderUrl: frontendImage ? frontendUrl : "https://release.example.test/confidential/",
      ...(frontendImage ? { manualTls: true as const } : {}),
    } } : {}) },
  guest: { measurement: "7".repeat(96), chipId: "8".repeat(128),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
  nodeSelector, network,
  trustee: { chart: TRUSTEE_CHART, version: "0.21.0", kbsImage: images.kbs,
    tngImage: images.tng, gatewayImage: images.gateway },
  storageImage: images.storage,
  containers: [{ name: "app", image: "ghcr.io/example/workload:owner-release-1",
    imageKeyResource: ["default", "image", "app"], commandFromImage: true, uid: 11000, gid: 11000,
    mounts: [{ storage: "data", path: "/data" }, { storage: "scratch", path: "/scratch" }],
    ports: [{ name: "app", port: 9080 }] }],
  storage: [{ name: "data", resource: "data" }, { name: "scratch", resource: "scratch" }],
  resources: [["default", "image", "app"], ["default", "volume", "data"]],
  runtime: { memoryMiB: 4096, vcpus: 2, k8sDistribution: "k0s", ociVersion: "1.3.0" },
} });
// HTTPS serves bootstrap metadata; guest ownership uses a separate raw TCP
// listener. The discovery service never terminates the guest's TNG/TLS channel.
new ApiObject(chart, "owner-gateway", { apiVersion: "gateway.networking.k8s.io/v1", kind: "Gateway",
  metadata: { name: "example-owner", namespace }, spec: { gatewayClassName: "replace-with-gateway-class",
    listeners: [{ name: "owner", protocol: "TCP", port: 8443 }, { name: "access", protocol: "HTTPS", port: 443,
      hostname: "owner.example.test", tls: { mode: "Terminate", certificateRefs: [{ name: "replace-with-discovery-certificate" }] } },
      ...(frontendImage ? [{ name: "browser-ui", protocol: "TCP", port: 9443 }] : []),
      ...(browserImage ? ["preparation", "workload"].map(name => ({ name, protocol: "HTTPS", port: 443,
        hostname: `${name}.example.test`, tls: { mode: "Terminate", certificateRefs: [{ name: `replace-with-${name}-certificate` }] } })) : [])] } });
new ApiObject(chart, "owner-route", { apiVersion: "gateway.networking.k8s.io/v1alpha2", kind: "TCPRoute",
  metadata: { name: "example-owner", namespace }, spec: { parentRefs: [{ name: "example-owner", sectionName: "owner" }],
    rules: [{ backendRefs: [{ name: "workload-owner", port: 8443 }] }] } });
if (frontendImage) new ApiObject(chart, "browser-ui-route", { apiVersion: "gateway.networking.k8s.io/v1alpha2", kind: "TCPRoute",
  metadata: { name: "example-browser-ui", namespace }, spec: { parentRefs: [{ name: "example-owner", sectionName: "browser-ui" }],
    rules: [{ backendRefs: [{ name: "example-browser-ui", port: 10443 }] }] } });
new ApiObject(chart, "access-route", { apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute",
  metadata: { name: "example-access", namespace }, spec: { parentRefs: [{ name: "example-owner", sectionName: "access" }],
    hostnames: ["owner.example.test"], rules: [{ backendRefs: [{ name: "confidential-operator-access", port: 8083 }] }] } });
if (browserImage) for (const [name, service] of [["preparation", "example-preparation"], ["workload", "workload-owner"]]) {
  // HTTPS termination carries only OHTTP ciphertext. This proxy never sees
  // owner JWTs, image plaintext, registry credentials or decryption keys.
  new ApiObject(chart, `${name}-browser-route`, { apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute",
    metadata: { name: `${name}-browser`, namespace }, spec: {
      parentRefs: [{ name: "example-owner", sectionName: name }], hostnames: [`${name}.example.test`],
      rules: [{ backendRefs: [{ name: service, port: 8445 }] }],
    } });
}
app.synth();
