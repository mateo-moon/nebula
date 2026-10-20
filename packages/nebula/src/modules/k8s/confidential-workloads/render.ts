import { App, Chart, Helm } from "cdk8s";
import { stringify } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { INIT_DATA_ANNOTATION, type GuestPodManifest } from "../confidential-guests/measured";
import { measuredFragments } from "../envoy";
import { extendTrusteeHelm, readTrusteeHelmPlan, trusteeHelmProps } from "../trustee/helm";
import { trusteeSettings } from "../trustee/settings";
import { tngBootstrapScript } from "../trustee/tng-bootstrap";
import { generateConfidentialWorkloadPolicy } from "../trustee/genpolicy";
import { snpIdentity, trusteePolicies } from "../trustee/policies";
import type { TrusteeConfig } from "../trustee/types";
import { validateWorkload } from "./validation";
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
  const runtime = spec.runtime ?? {};
  const config: TrusteeConfig = {
    ...spec.trustee, name: spec.profile, namespace: metadata.namespace,
    ownerPublicKeyPem: spec.ownerPublicKeyPem, guest: spec.guest, network: spec.network,
    nodeSelector: spec.nodeSelector, clients: [{ namespace: metadata.namespace, podLabels: { app: spec.profile } }],
    genpolicy: options.genpolicy, k8sDistribution: runtime.k8sDistribution, ociVersion: runtime.ociVersion,
  };
  const settings = trusteeSettings(config);
  const app = new App(), chart = new Chart(app, "confidential-components");
  const helm = new Helm(chart, "trustee", trusteeHelmProps(config, settings));
  extendTrusteeHelm(helm, settings);
  const base = readTrusteeHelmPlan(helm, config, settings).pod;
  const kbs: any = structuredClone(base.spec.containers[0]);
  kbs.securityContext = security(10001);
  kbs.restartPolicy = "Always";
  // Kubelet TCP probes target the Pod IP; KBS is intentionally guest-loopback.
  // Start ordering requires a guest-local probe and would need ExecProcess,
  // which is denied. The later gateway can start independently; requests fail
  // closed until KBS is listening.
  delete kbs.ports;
  const tngConfig = structuredClone(settings.tngConfig) as any;
  tngConfig.add_egress[0].mapping.out.port = 8444;
  const tng: any = structuredClone(base.spec.containers[1]);
  tng.name = "nebula-tng";
  tng.securityContext = security(10001);
  tng.args = measuredFragments(Buffer.from(tngBootstrapScript(tngConfig)).toString("base64"));
  tng.restartPolicy = "Always";
  const gateway = { name: "nebula-owner", image: spec.trustee.gatewayImage, imagePullPolicy: "Always",
    command: ["node", "/app/dist/main.js"], args: ["gateway"], restartPolicy: "Always",
    securityContext: security(10001), resources: limits,
    volumeMounts: [mount("instance", "/run/instance"), mount("owner-tmp", "/tmp")] };
  const initContainers: any[] = [kbs, gateway, tng];
  const volumes: any[] = [...structuredClone(base.spec.volumes), memory("instance"), memory("owner-tmp")];
  const bindings = (spec.storage ?? []).map(binding => ({ ...binding,
    spec: storages.find(storage => storage.metadata.namespace === metadata.namespace && storage.metadata.name === binding.resource)!.spec }));
  const encrypted = bindings.filter(binding => binding.spec.type === "EncryptedBlock");
  gateway.args.push(JSON.stringify({ storageNames: encrypted.map(binding => binding.name),
    resources: spec.resources.map(path => path.join("/")) }));
  gateway.volumeMounts.push(...encrypted.map(binding =>
    mount(`state-${binding.name}`, `/run/nebula-storage/${binding.name}`, true)));
  // Do not create a CDH attestation session under the initial deny policy.
  // Native clients may cache that non-affirming token until it expires.
  initContainers.push({ name: "nebula-await-owner", image: spec.trustee.gatewayImage, imagePullPolicy: "Always",
    command: ["node", "/app/dist/main.js"], args: ["await-owner", JSON.stringify(spec.resources.map(path => path.join("/")))],
    securityContext: security(10001), resources: limits });
  if (encrypted.length) {
    volumes.push(memory("storage-runtime", "32Mi"));
    initContainers.push({ name: "nebula-install-storage", image: spec.storageImage, imagePullPolicy: "Always",
      command: ["/usr/local/bin/coco-key-api"], args: ["generic-install"],
      securityContext: security(0), resources: limits,
      volumeMounts: [mount("storage-runtime", "/run/nebula-runtime")] });
  }
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
      command: ["/usr/local/bin/coco-key-api"], args: ["generic-serve", JSON.stringify(storageConfig)],
      restartPolicy: "Always", securityContext: security(0, 0, ["SYS_ADMIN", "MKNOD", "CHOWN"]),
      resources: limits, volumeDevices: [{ name: volumeName, devicePath: "/dev/coco-data" }],
      volumeMounts: [mount(`state-${binding.name}`, "/run/volume")] });
  }
  const containers = spec.containers.map(container => {
    const blockMounts = (container.mounts ?? []).filter(m => encrypted.some(binding => binding.name === m.storage));
    const directMounts = (container.mounts ?? []).filter(m => !blockMounts.includes(m));
    const launch = { version: 1, uid: container.uid, gid: container.gid,
      mounts: blockMounts.map(m => ({ socket: `/run/nebula-mounts/${m.storage}/mount.sock`, path: m.path })) };
    return {
      name: container.name, image: container.image, imagePullPolicy: "Always",
      command: blockMounts.length ? ["/run/nebula-runtime/coco-key-api"] : [...container.command],
      args: blockMounts.length ? ["generic-launch", JSON.stringify(launch), "--", ...container.command, ...(container.args ?? [])] : [...(container.args ?? [])],
      env: Object.entries(container.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })),
      securityContext: blockMounts.length ? security(0, 0, ["SYS_ADMIN", "SETPCAP", "SETUID", "SETGID"]) : security(container.uid, container.gid),
      resources: container.resources ?? limits,
      volumeMounts: [
        ...directMounts.map(m => mount(`app-${m.storage}`, m.path)),
        ...(blockMounts.length ? [mount("storage-runtime", "/run/nebula-runtime", true)] : []),
        ...blockMounts.map(m => mount(`state-${m.storage}`, `/run/nebula-mounts/${m.storage}`, true)),
      ],
      ...(container.ports?.length ? { ports: container.ports.map(p => ({ name: p.name, containerPort: p.port })) } : {}),
    };
  });
  const pod: GuestPodManifest = { apiVersion: "v1", kind: "Pod", metadata: {
    generateName: `${spec.profile}-`, namespace: metadata.namespace,
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
  for (const container of [...initContainers, ...containers]) container.command = privateStdio(container.command);
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
