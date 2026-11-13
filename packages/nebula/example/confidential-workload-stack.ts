/** Complete declaration example. Replace public pins and host configuration
 * with independently reviewed values before applying its synthesized YAML.
 * No private key, image key or registry password belongs in this file.
 *
 *   pnpm exec cdk8s synth --app 'tsx example/confidential-workload-stack.ts'
 *
 * Set CONFIDENTIAL_PUBLIC_IP, CONFIDENTIAL_SNP_NODE and CONFIDENTIAL_ACME_EMAIL
 * for the host. The stack owns ports 80/443 and HTTPS relays 8440/8441/8442;
 * direct guest TLS uses 9443 (browser) and 8443 (native owner client).
 * Set CONFIDENTIAL_BROWSER_IMAGE, CONFIDENTIAL_BROWSER_TLS_IMAGE and
 * CONFIDENTIAL_BROWSER_TLS_TNG_IMAGE together to reviewed digest pins. Supply
 * CONFIDENTIAL_BROWSER_TLS_MEASUREMENT and CONFIDENTIAL_BROWSER_TLS_INIT_DATA_SHA256
 * from independent approval of that exact frontend; never learn trust from the
 * endpoint itself. The user compares the actual browser certificate before
 * entering the separately supplied token. The welcome page accepts no secrets.
 * CONFIDENTIAL_MAX_IMAGE_SIZE_MIB=4096 enables 4 GiB archive uploads with
 * a 32 GiB preparation VM; the host must have that capacity available.
 */
import { App, Chart, ApiObject } from "cdk8s";
import { isIP } from "node:net";
import { SealedDisks } from "../src/modules/k8s/confidential-guests/sealed-disks";
import { ConfidentialBrowser, ConfidentialOperator, ConfidentialStorage, ConfidentialStorageDevices,
  ConfidentialWelcome, ConfidentialWorkload, type ConfidentialStorageResource } from "../src/modules/k8s/confidential-workloads";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";

const namespace = "confidential-example";
const node = process.env.CONFIDENTIAL_SNP_NODE ?? "replace-with-snp-node";
const profile = "example-workload";
const publicIp = process.env.CONFIDENTIAL_PUBLIC_IP ?? "192.0.2.10";
if (isIP(publicIp) !== 4) throw new Error("CONFIDENTIAL_PUBLIC_IP must be the host's literal public IPv4 address");
const endpoints = { metadata: `https://${publicIp}:8440/`, preparation: `https://${publicIp}:8441/`,
  owner: `https://${publicIp}:8442/`, frontend: `https://${publicIp}:9443/` };
const browserImage = process.env.CONFIDENTIAL_BROWSER_IMAGE;
const maxImageSizeMiB = process.env.CONFIDENTIAL_MAX_IMAGE_SIZE_MIB === undefined ? undefined : Number(process.env.CONFIDENTIAL_MAX_IMAGE_SIZE_MIB);
const frontendImage = process.env.CONFIDENTIAL_BROWSER_TLS_IMAGE;
const frontendTngImage = process.env.CONFIDENTIAL_BROWSER_TLS_TNG_IMAGE;
const frontendMeasurement = process.env.CONFIDENTIAL_BROWSER_TLS_MEASUREMENT;
const frontendPolicyHash = process.env.CONFIDENTIAL_BROWSER_TLS_INIT_DATA_SHA256;
if ((browserImage || frontendImage || frontendTngImage) && !(browserImage && frontendImage && frontendTngImage)) {
  throw new Error("The browser flow needs reviewed preparation, frontend and HTTP/1.1 TNG images together");
}
if (frontendImage && (!/^[a-f0-9]{96}$/.test(frontendMeasurement ?? "") || !/^[a-f0-9]{64}$/.test(frontendPolicyHash ?? ""))) {
  throw new Error("Supply the independently approved frontend SNP measurement and native Init-Data SHA-256");
}
const nodeSelector = { "kubernetes.io/hostname": node };
const network = { ipv4AddressPattern: "^10[.]244[.][0-9]{1,3}[.][0-9]{1,3}$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" };
const images = {
  operator: "ghcr.io/example/confidential-operator@sha256:" + "1".repeat(64),
  injector: "ghcr.io/example/confidential-storage-devices@sha256:" + "2".repeat(64),
  agent: "ghcr.io/example/confidential-agent@sha256:" + "3".repeat(64),
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
// Preparation receives ciphertext and runs native policy generation. The
// separately released first-page verifier pins this preparation's measurements.
if (browserImage) new ConfidentialBrowser(chart, "preparation", { name: "example-preparation", namespace,
  agentImage: browserImage, tngImage: images.tng, nodeSelector, network, maxImageSizeMiB });
if (frontendImage) new ConfidentialBrowser(chart, "browser-ui", { name: "example-browser-ui", namespace,
  agentImage: frontendImage, tngImage: frontendTngImage!, nodeSelector, network,
  manualTls: { preparationEndpoint: endpoints.preparation, stackEndpoint: endpoints.metadata } });
new SealedDisks(chart, "ciphertext-disk", {
  namespace, nodeName: node, image: images.disks,
  stateDir: "/var/lib/confidential-example", roles: [{ role: "data", claim: "example-data",
    file: "data", sizeBytes: 1073741824, sizeLabel: "1Gi", provisioner: "example-data" }],
  table: { live: { data: { generation: 1, loop: 240 } }, retained: [], retired: [],
    reservedLoops: [], protectedLoops: [], firstPinnedLoop: 240 },
});
new ConfidentialStorageDevices(chart, "devices", { name: "example-devices", namespace,
  nodeName: node, image: images.injector, pluginIndex: "64", agentProfiles: [profile] });
const storages: ConfidentialStorageResource[] = [{ apiVersion: "confidential.nebula.dev/v1alpha1",
  kind: "ConfidentialStorage", metadata: { name: "data", namespace }, spec: {
    type: "EncryptedBlock", claimName: "example-data-v1", sizeBytes: 1073741824,
    keyResource: ["default", "volume", "data"], initialization: "IfEmpty", retention: "Retain",
  } }, { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
  metadata: { name: "scratch", namespace }, spec: { type: "Memory", sizeLimit: "32Mi" } }];
for (const storage of storages) new ConfidentialStorage(chart, storage.metadata.name,
  { name: storage.metadata.name, namespace, spec: storage.spec });
new ConfidentialWorkload(chart, "workload", { name: "workload", namespace, storages, spec: {
  profile, browserOwner: true,
  accessLink: { url: endpoints.metadata, ownerPort: 8443, secretName: "workload-access",
    ...(browserImage ? { browser: {
      invitationEndpoint: `http://example-preparation-invitation.${namespace}.svc:8089/invitation`,
      workloadEndpoint: endpoints.preparation, ownerEndpoint: endpoints.owner,
      loaderUrl: endpoints.frontend, manualTls: true,
    } } : {}) },
  guest: { measurement: "7".repeat(96), chipId: "8".repeat(128),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
  nodeSelector, network,
  trustee: { chart: TRUSTEE_CHART, version: "0.21.0", kbsImage: images.kbs,
    tngImage: images.tng },
  agentImage: images.agent,
  containers: [{ name: "app", image: "ghcr.io/example/workload:owner-release-1",
    imageKeyResource: ["default", "image", "app"], commandFromImage: true, uid: 11000, gid: 11000,
    mounts: [{ storage: "data", path: "/data" }, { storage: "scratch", path: "/scratch" }],
    ports: [{ name: "app", port: 9080 }] }],
  storage: [{ name: "data", resource: "data" }, { name: "scratch", resource: "scratch" }],
  resources: [["default", "image", "app"], ["default", "volume", "data"]],
  runtime: { memoryMiB: 4096, vcpus: 2, k8sDistribution: "k0s", ociVersion: "1.3.0" },
} });
// Direct Services preserve the guest's TLS certificate through the first page
// and native owner connection. No shared ingress terminates either channel.
new ApiObject(chart, "native-owner", { apiVersion: "v1", kind: "Service",
  metadata: { name: "example-owner-native", namespace }, spec: { externalIPs: [publicIp], publishNotReadyAddresses: true,
    selector: { "confidential.nebula.dev/profile": profile },
    ports: [{ name: "owner", port: 8443, targetPort: 8443 }] } });
new ApiObject(chart, "owner-ohttp", { apiVersion: "v1", kind: "Service",
  metadata: { name: "example-owner-ohttp", namespace }, spec: { publishNotReadyAddresses: true,
    selector: { "confidential.nebula.dev/profile": profile },
    ports: [{ name: "ohttp", port: 8445, targetPort: 8445 }] } });
if (frontendImage) new ApiObject(chart, "browser-ui-public", { apiVersion: "v1", kind: "Service",
  metadata: { name: "example-browser-ui-public", namespace }, spec: { externalIPs: [publicIp],
    selector: { "confidential.nebula.dev/browser": "example-browser-ui" },
    ports: [{ name: "https", port: 9443, targetPort: 10443 }] } });
const acmeClaim = "example-welcome-acme";
new ApiObject(chart, "acme-claim", { apiVersion: "v1", kind: "PersistentVolumeClaim",
  metadata: { name: acmeClaim, namespace, annotations: { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } },
  // Use the administrator's existing default filesystem StorageClass. Keep the
  // claim through stack removal to retain Caddy's ACME account and TLS keys.
  spec: { accessModes: ["ReadWriteOnce"], volumeMode: "Filesystem", resources: { requests: { storage: "128Mi" } } } });
new ConfidentialWelcome(chart, "welcome", { name: "example-welcome", namespace, ipAddress: publicIp,
  acmeEmail: process.env.CONFIDENTIAL_ACME_EMAIL ?? "replace@example.test", acmeClaimName: acmeClaim, nodeSelector,
  portalUrl: endpoints.frontend,
  ...(frontendImage ? { portalService: { name: "example-browser-ui", namespace }, reference: {
    measurement: frontendMeasurement!, initDataSha256: frontendPolicyHash!,
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 },
  } } : {}),
  publicOhttpRoutes: [{ port: 8440, upstream: `http://confidential-operator-access.${namespace}.svc:8083/` },
    ...(browserImage ? [{ port: 8441, upstream: `http://example-preparation.${namespace}.svc:8445/` }] : []),
    { port: 8442, upstream: `http://example-owner-ohttp.${namespace}.svc:8445/` }],
});
app.synth();
