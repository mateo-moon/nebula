import { App, Chart, Helm } from "cdk8s";
import { stringify } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { INIT_DATA_ANNOTATION, type GuestPodManifest } from "../confidential-guests/measured";
import { measuredFragments } from "../envoy/measured-fragments";
import { extendTrusteeHelm, readTrusteeHelmPlan, trusteeHelmProps } from "../trustee/helm";
import { trusteeSettings } from "../trustee/settings";
import { tngBootstrapScript } from "../trustee/tng-bootstrap";
import { generateConfidentialWorkloadPolicy } from "../trustee/genpolicy";
import { snpIdentity, trusteePolicies } from "../trustee/policies";
import type { TrusteeConfig } from "../trustee/types";
import { validateWorkload } from "./validation";
import { TRUSTEE_CHART, TRUSTEE_CHART_VERSION } from "./chart";
import { resolvePublishedImage, imageCommand } from "./published-image";
import type { ConfidentialStorageResource, ConfidentialWorkloadResource, WorkloadRenderOptions } from "./types";

const limits = { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } };
const security = (uid: number, gid = uid, capabilities: string[] = []) => ({
  runAsUser: uid, runAsGroup: gid, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"], ...(capabilities.length ? { add: capabilities } : {}) },
});
const memory = (name: string, sizeLimit = "128Mi") => ({ name, emptyDir: { medium: "Memory", sizeLimit } });
const mount = (name: string, mountPath: string, readOnly = false) => ({ name, mountPath, ...(readOnly ? { readOnly } : {}) });
const privateStdio = (command: string[]) => ["/bin/sh", "-ec", 'exec "$@" </dev/null >/dev/null 2>&1', "private-stdio", ...command];

/** Public resource identities are separate from the eventual random Pod name.
 * genpolicy's native generateName handling allows identical measured copies;
 * private enrollment, not metadata uniqueness, chooses the provisioned VM. */
export function renderConfidentialWorkload(resource: ConfidentialWorkloadResource,
  storages: readonly ConfidentialStorageResource[], options: WorkloadRenderOptions = {}) {
  validateWorkload(resource, storages);
  const { spec, metadata } = resource;
  if (spec.accessLink) throw new TypeError("Confidential workload: access link must be resolved to its public token commitment before rendering");
  const runtime = spec.runtime ?? {};
  const config: TrusteeConfig = {
    ...spec.trustee, chart: TRUSTEE_CHART, repository: undefined, version: TRUSTEE_CHART_VERSION,
    name: spec.profile, namespace: metadata.namespace,
    ownerPublicKeyPem: spec.ownerPublicKeyPem, ownerClaimSha256: spec.ownerClaimSha256,
    guest: spec.guest, network: spec.network,
    nodeSelector: spec.nodeSelector, clients: [{ namespace: metadata.namespace, podLabels: { app: spec.profile } }],
    genpolicy: options.genpolicy, k8sDistribution: runtime.k8sDistribution, ociVersion: runtime.ociVersion,
  };
  const settings = trusteeSettings(config);
  const app = new App(), chart = new Chart(app, "confidential-components");
  const helm = new Helm(chart, "trustee", trusteeHelmProps(config, settings));
  extendTrusteeHelm(helm, settings);
  const base = readTrusteeHelmPlan(helm, config, settings).pod;
  const kbsSource = base.spec.containers.find(container => container.name === "kbs");
  const tngSource = base.spec.containers.find(container => container.name === "tng");
  if (base.spec.containers.length !== 2 || !kbsSource || !tngSource) {
    throw new TypeError("Confidential workload: unexpected Trustee container topology");
  }
  const kbs: any = structuredClone(kbsSource);
  kbs.securityContext = security(10001);
  kbs.restartPolicy = "Always";
  if (spec.ownerClaimSha256) kbs.volumeMounts.push(mount("instance", "/run/instance"));
  // Kubelet TCP probes target the Pod IP; KBS is intentionally guest-loopback.
  // Start ordering requires a guest-local probe and would need ExecProcess,
  // which is denied. The later gateway can start independently; requests fail
  // closed until KBS is listening.
  delete kbs.ports;
  const tngConfig = structuredClone(settings.tngConfig) as any;
  tngConfig.add_egress[0].mapping.out.port = 8444;
  if (spec.browserOwner) tngConfig.add_egress.push({
    mapping: { in: { host: "0.0.0.0", port: 8445 }, out: { host: "127.0.0.1", port: 8447 } },
    attest: { aa_provider: "coco_asr", asr_addr: "http://127.0.0.1:8007", refresh_interval: 0 },
    ohttp: { key: { source: "file", path: "/run/instance/identity/ohttp.pem" }, forward_client_ip: false,
      cors: { allow_origins: ["*"], allow_methods: ["GET", "POST", "OPTIONS"], allow_headers: ["*"], expose_headers: [], allow_credentials: false } },
  });
  const tng: any = structuredClone(tngSource);
  tng.name = "nebula-tng";
  tng.securityContext = security(10001);
  const tngStartup = tngBootstrapScript(tngConfig);
  tng.args = measuredFragments(Buffer.from(spec.browserOwner ? tngStartup.replace("exec tng launch", "while [ ! -s /run/instance/identity/ohttp.pem ]; do sleep 1; done\nexec tng launch") : tngStartup).toString("base64"));
  if (spec.browserOwner) tng.volumeMounts.push(mount("instance", "/run/instance", true));
  tng.restartPolicy = "Always";
  const gateway = { name: "nebula-owner", image: spec.trustee.gatewayImage, imagePullPolicy: "Always",
    command: ["node", "/app/dist/main.js"], args: ["gateway"], restartPolicy: "Always",
    securityContext: security(10001), resources: limits,
    volumeMounts: [mount("instance", "/run/instance"), mount("owner-tmp", "/tmp")] };
  const guard = { name: "nebula-guard", image: spec.trustee.gatewayImage, imagePullPolicy: "Always",
    command: ["node", "/app/dist/main.js"], args: ["guard"],
    securityContext: security(0, 0, ["NET_ADMIN"]), resources: limits,
    volumeMounts: [mount("guest-guard", "/run/nebula-guard")] };
  const initContainers: any[] = [guard, kbs, gateway, tng];
  const volumes: any[] = [...structuredClone(base.spec.volumes), memory("instance"), memory("owner-tmp"),
    memory("guest-guard", "1Mi"), memory("owner-ready", "1Mi"), memory("storage-runtime", "32Mi")];
  const bindings = (spec.storage ?? []).map(binding => ({ ...binding,
    spec: storages.find(storage => storage.metadata.namespace === metadata.namespace && storage.metadata.name === binding.resource)!.spec }));
  const encrypted = bindings.filter(binding => binding.spec.type === "EncryptedBlock");
  gateway.args.push(JSON.stringify({ storageNames: encrypted.map(binding => binding.name),
    resources: spec.resources.map(path => path.join("/")),
    ...(spec.browserOwner ? { browser: true } : {}),
    ...(spec.ownerClaimSha256 ? { ownerClaimSha256: spec.ownerClaimSha256, audience: spec.profile } : {}) }));
  gateway.volumeMounts.push(...encrypted.map(binding =>
    mount(`state-${binding.name}`, `/run/nebula-storage/${binding.name}`, true)));
  const resourceClients = spec.containers.filter(container => container.applicationResources?.length);
  for (const client of resourceClients) volumes.push(memory(`resource-${client.name}`, "1Mi"));
  if (resourceClients.length) initContainers.push({ name: "nebula-resource-broker", image: spec.storageImage, imagePullPolicy: "Always",
    command: ["/usr/local/bin/nebula-confidential-storage"],
    args: ["resource-broker", JSON.stringify({ version: 1, clients: resourceClients.map(client => ({
      name: client.name, uid: client.uid, gid: client.gid,
      resources: client.applicationResources!.map(path => path.join("/")),
    })) })], restartPolicy: "Always", securityContext: security(0, 0, ["CHOWN"]), resources: limits,
    volumeMounts: resourceClients.map(client => mount(`resource-${client.name}`, `/run/nebula-resources/${client.name}`)) });
  // Do not create a CDH attestation session under the initial deny policy.
  // Native clients may cache that non-affirming token until it expires.
  initContainers.push({ name: "nebula-await-owner", image: spec.trustee.gatewayImage, imagePullPolicy: "Always",
    command: ["node", "/app/dist/main.js"], args: ["await-owner", JSON.stringify(spec.resources.map(path => path.join("/")))],
    securityContext: security(10001), resources: limits,
    volumeMounts: [mount("owner-ready", "/run/nebula-owner-ready")] });
  initContainers.push({ name: "nebula-install-storage", image: spec.storageImage, imagePullPolicy: "Always",
    command: ["/usr/local/bin/nebula-confidential-storage"], args: ["install"],
    securityContext: security(0), resources: limits,
    volumeMounts: [mount("storage-runtime", "/run/nebula-runtime")] });
  for (const binding of bindings) {
    const volumeName = `app-${binding.name}`;
    if (binding.spec.type === "Memory") {
      volumes.push(memory(volumeName, binding.spec.sizeLimit));
      continue;
    }
    const storage = binding.spec;
    volumes.push({ name: volumeName, persistentVolumeClaim: { claimName: storage.claimName } },
      memory(`state-${binding.name}`));
    const clients = spec.containers.filter(container => container.mounts?.some(m => m.storage === binding.name))
      .map(container => ({ name: container.name, uid: container.uid, gid: container.gid }));
    const storageConfig = { version: 1, name: binding.name, sizeBytes: storage.sizeBytes,
      keyResource: storage.keyResource.join("/"), initialization: storage.initialization, clients };
    initContainers.push({ name: `nebula-storage-${binding.name}`, image: spec.storageImage, imagePullPolicy: "Always",
      command: ["/usr/local/bin/nebula-confidential-storage"], args: ["serve", JSON.stringify(storageConfig)],
      restartPolicy: "Always", securityContext: security(0, 0, ["SYS_ADMIN", "MKNOD", "CHOWN"]),
      resources: limits, volumeDevices: [{ name: volumeName, devicePath: "/dev/coco-data" }],
      volumeMounts: [mount(`state-${binding.name}`, "/run/volume")] });
  }
  const containers = spec.containers.map(container => {
    const image = container.imageKeyResource && !container.image.includes("@sha256:")
      ? resolvePublishedImage(container.image, container.imageKeyResource,
        options.publishedImageDigests?.[container.image]) : container.image;
    const command = container.commandFromImage ? imageCommand(image, options.publishedImageConfigs?.[container.image])
      : [...container.command!, ...(container.args ?? [])];
    const blockMounts = (container.mounts ?? []).filter(m => encrypted.some(binding => binding.name === m.storage));
    const directMounts = (container.mounts ?? []).filter(m => !blockMounts.includes(m));
    const launch = { version: 1, uid: container.uid, gid: container.gid,
      mounts: blockMounts.map(m => ({ socket: `/run/nebula-mounts/${m.storage}/mount.sock`, path: m.path })) };
    return {
      name: container.name,
      image,
      imagePullPolicy: "Always",
      command: ["/run/nebula-runtime/nebula-confidential-storage"],
      args: ["launch", JSON.stringify(launch), "--", ...command],
      env: Object.entries(container.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })),
      securityContext: security(0, 0, ["SYS_ADMIN", "SETPCAP", "SETUID", "SETGID"]),
      resources: container.resources ?? limits,
      volumeMounts: [
        ...directMounts.map(m => mount(`app-${m.storage}`, m.path)),
        mount("storage-runtime", "/run/nebula-runtime", true),
        mount("guest-guard", "/run/nebula-guard", true),
        mount("owner-ready", "/run/nebula-owner-ready", true),
        ...(container.applicationResources?.length ? [mount(`resource-${container.name}`, "/run/nebula-resources", true)] : []),
        ...blockMounts.map(m => mount(`state-${m.storage}`, `/run/nebula-mounts/${m.storage}`, true)),
      ],
      ...(container.ports?.length ? { ports: container.ports.map(p => ({ name: p.name, containerPort: p.port })) } : {}),
    };
  });
  const pod: GuestPodManifest = { apiVersion: "v1", kind: "Pod", metadata: {
    generateName: `${spec.profile}-`, namespace: metadata.namespace,
    ...(spec.browserOwner ? { labels: { "confidential.nebula.dev/profile": spec.profile } } : {}),
    annotations: { ...base.metadata.annotations,
      "io.katacontainers.config.hypervisor.default_memory": String(runtime.memoryMiB ?? 4096),
      "io.katacontainers.config.hypervisor.default_vcpus": String(runtime.vcpus ?? 2),
      "io.katacontainers.config.hypervisor.kernel_params":
        "agent.guest_components_procs=api-server-rest agent.guest_components_rest_api=all agent.aa_kbc_params=cc_kbc::http://127.0.0.1:8080",
    },
  }, spec: {
    runtimeClassName: "kata-qemu-snp", nodeSelector: spec.nodeSelector,
    automountServiceAccountToken: false, enableServiceLinks: false, restartPolicy: "Never",
    terminationGracePeriodSeconds: 90, securityContext: { fsGroup: 10001, supplementalGroups: [0, 10001] },
    initContainers, containers, volumes,
  } };
  // Only trusted helper images may execute their own shell. The application
  // image's first instruction must be the measured static launcher, which
  // drops root/capabilities before running any bytes from that image.
  for (const container of initContainers) container.command = privateStdio(container.command);
  const aa = stringify({ token_configs: { kbs: { url: "http://127.0.0.1:8080" } }, log: { level: "off" } });
  const cdh = stringify({ kbc: { name: "cc_kbc", url: "http://127.0.0.1:8080" }, log: { level: "off" },
    image: { kbc: "cc_kbc", kbs_uri: "http://127.0.0.1:8080", max_concurrent_layer_downloads_per_image: 1,
      ...(spec.registryMirrors?.length ? { registry_config: { registry: spec.registryMirrors } } : {}) } });
  const generated = generateConfidentialWorkloadPolicy(pod, { "aa.toml": aa, "cdh.toml": cdh }, config);
  const identity = snpIdentity({ ...spec.guest, initDataSha256: generated.initDataSha256 });
  const policies = trusteePolicies(spec.resources.map(path => ({ path, recipients: [identity] })));
  // Names and claim routes are intentionally outside the instance credential.
  // Native policy still binds the container layout and allowed block recipients.
  const measuredPod = { ...pod, metadata: { ...pod.metadata,
    annotations: { ...pod.metadata!.annotations, [INIT_DATA_ANNOTATION]: generated.ccInitData } } };
  return { pod: measuredPod, identity, policies, audience: spec.profile,
    specSha256: sha256Hex(canonicalJson({ spec, storage: bindings.map(binding => binding.spec) })) };
}
