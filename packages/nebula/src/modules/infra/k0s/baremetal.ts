import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import {
  CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope, CompositeResourceDefinitionV2SpecDefaultCompositionUpdatePolicy,
  Composition, CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { baremetalEnrollmentManifests } from "./baremetal/enrollment";
import { baremetalWorkerTemplate } from "./baremetal/template";
import { validateUefi, type BaremetalUefiConfiguration } from "./baremetal/uefi";

/** One worker's address, with optional overrides of the shared defaults. */
export interface BaremetalNode {
  address: string;
  /** Stable installed hostname; defaults to bm-<IPv4-with-dashes>. */
  name?: string;
  /** Privileged account on the source OS. The installed worker uses root. */
  sshUser?: string;
  sshPort?: number;
  geo?: string;
  region?: string;
  zone?: string;
  nodeLabels?: Record<string, string>;
  taints?: string[];
}

/** Select the shared installation and enrollment Composition. */
export interface BaremetalFleetOptions { compositionName?: string }

export interface BaremetalBootArtifact { url: string; sha256: string }

/** Shared installation policy, independent of the server supplier. */
export interface BaremetalInstallation {
  /** Optional, hardware-bound UEFI settings applied and verified before k0s enrollment. */
  uefi?: BaremetalUefiConfiguration;
  /** Debian amd64 netboot kernel and initrd, from the same installer release. */
  kernel: BaremetalBootArtifact;
  initrd: BaremetalBootArtifact;
  suite: string;
  /** Debian archive hostname and path. Signed archive verification stays enabled. */
  mirror: { hostname: string; directory: string };
  /** Existing root disk is selected only when it resolves to ONE physical disk.
   * A rescue OS requires an exact serial. Destructive cleanup is opt-in. */
  disk: {
    serial?: string;
    minSizeGiB: number;
    /** From a RAM/rescue OS only: erase these exact disks, including any MD
     * arrays wholly contained in them. Must include serial. Mounted storage,
     * shared arrays, LVM, encryption and multipath are refused. */
    eraseSerials?: string[];
    /** Additional erased disks dedicated in full to the workload volume group.
     * Each must also appear in eraseSerials and differ from the OS disk. */
    workloadSerials?: string[];
  };
  rootSizeGiB: number;
  /** Installed root LV shares this VG; unallocated extents remain for local PVCs. */
  volumeGroup: string;
  /** Explicit resolvers, or discover non-loopback resolvers on the source host. */
  dnsServers?: string[];
  /** Persist and verify global IPv6 in addition to IPv4. Default true. */
  dualStack?: boolean;
  /** Deadline after committing kexec. Expiry stops retries; it never reimages. */
  timeoutSeconds?: number;
}

export interface BaremetalSetupOptions {
  /** CAPI cluster name (Machine.clusterName + cluster label). */
  clusterName: string;
  /** k0s version for K0sWorkerConfig/Machine, e.g. "v1.35.7+k0s.0". */
  k0sVersion: string;
  /** Secret holding the provisioner's SSH private key under key "value". */
  sshSecretName: string;
  /** Organization tag/label domain, e.g. "example.com". */
  tagDomain: string;
  /** Namespace for the adoption objects (default "default"). */
  namespace?: string;

  /** Shared Composition name, selected by each host XR. */
  name?: string;
  /** Runtime image built from this module's Dockerfile, pinned by digest. */
  image: string;
  installation: BaremetalInstallation;
  initialSshSecretName?: string;
  /** Initial Secret's value is a private key by default, or a bootstrap password.
   * Password access ends at OS installation; the worker always uses its SSH key. */
  initialSshAuthentication?: "privateKey" | "password";
  initialSshUser?: string;
  initialSshPort?: number;
  /** Secret key known_hosts; HostKeyAlias is the worker's installed hostname. */
  knownHostsSecretName?: string;
  trustOnFirstUse?: boolean;
  defaults: Required<Pick<BaremetalNode, "geo" | "region" | "zone">>
    & Pick<BaremetalNode, "nodeLabels" | "taints">;
  /** Optional dedicated /32. Each IPv4 deterministically supplies a /64. */
  ipv6PodCidrPrefix?: string;
  /** Existing workload ProviderConfig, used only for native Node admission. */
  workloadKubeProviderConfigName?: string;
  /** Local management-cluster ProviderConfig. */
  kubeProviderConfigName?: string;
  kubernetesProviderServiceAccount?: { name: string; namespace: string };
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Baremetal worker: ${message}`);
}
const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const labelValue = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/;
const hostnamePattern = "^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$";
const sshUserPattern = "^[a-z_][a-z0-9_-]*$";
const labelPattern = "^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$";
const taintPattern = "^[A-Za-z0-9_./-]+(?:=[A-Za-z0-9_.-]+)?:(NoSchedule|NoExecute|PreferNoSchedule)$";

function validateNode(node: Omit<BaremetalNode, "address">): void {
  requireValue(node.name === undefined || (node.name.length <= 63 && new RegExp(hostnamePattern).test(node.name)), "invalid hostname");
  requireValue(node.sshUser === undefined || (node.sshUser.length <= 32 && new RegExp(sshUserPattern).test(node.sshUser)), "invalid SSH user");
  requireValue(node.sshPort === undefined || (Number.isInteger(node.sshPort) && node.sshPort >= 1 && node.sshPort <= 65535), "invalid SSH port");
  for (const value of [node.geo, node.region, node.zone])
    requireValue(value === undefined || (labelValue.test(value) && value.length <= 63), "invalid topology label");
  requireValue(Object.keys(node.nodeLabels ?? {}).length <= 64, "too many node labels");
  for (const [key, value] of Object.entries(node.nodeLabels ?? {}))
    requireValue(key.length <= 253 && /^[A-Za-z0-9_./-]+$/.test(key) && value.length <= 63 && (!value || labelValue.test(value)), "invalid node label");
  requireValue((node.taints?.length ?? 0) <= 64, "too many taints");
  for (const taint of node.taints ?? [])
    requireValue(taint.length <= 253 && new RegExp(taintPattern).test(taint), "invalid taint");
}

/** One worker: Crossplane installs its OS, verifies it, then publishes CAPI enrollment. */
export function baremetalWorker(scope: Construct, o: BaremetalFleetOptions, input: string | BaremetalNode): ApiObject {
  const node = typeof input === "string" ? { address: input } : input;
  requireValue(isIP(node.address) === 4, "this installer requires an IPv4 SSH address");
  validateNode(node);
  const name = node.name ?? `bm-${node.address.replaceAll(".", "-")}`;
  const compositionName = o.compositionName ?? "baremetal-worker";
  requireValue(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(compositionName), "composition name must be a DNS label of 2–40 characters");
  return new ApiObject(scope, name, {
    apiVersion: "nebula.io/v1alpha1", kind: "XBaremetalWorker",
    metadata: { name, annotations: { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } },
    spec: {
      address: node.address,
      ...(node.name !== undefined ? { hostname: node.name } : {}),
      ...(node.sshUser !== undefined ? { sshUser: node.sshUser } : {}),
      ...(node.sshPort !== undefined ? { sshPort: node.sshPort } : {}),
      ...(node.geo !== undefined ? { geo: node.geo } : {}),
      ...(node.region !== undefined ? { region: node.region } : {}),
      ...(node.zone !== undefined ? { zone: node.zone } : {}),
      ...(node.nodeLabels !== undefined ? { nodeLabels: node.nodeLabels } : {}),
      ...(node.taints !== undefined ? { taints: node.taints } : {}),
      crossplane: { compositionRef: { name: compositionName }, compositionUpdatePolicy: "Manual" },
    },
  });
}

/** A fleet uses the same worker lifecycle and shared Composition for every IP. */
export class BaremetalFleet extends Construct {
  private readonly workers = new Map<string, ApiObject>();
  public get hosts(): readonly ApiObject[] { return [...this.workers.values()]; }
  constructor(scope: Construct, id: string, private readonly options: BaremetalFleetOptions = {}) { super(scope, id); }
  addNode(node: string | BaremetalNode): ApiObject {
    const address = typeof node === "string" ? node : node.address;
    requireValue(!this.workers.has(address), "duplicate host address");
    const worker = baremetalWorker(this, this.options, node);
    this.workers.set(address, worker);
    return worker;
  }
}

function validateInstallation(p: BaremetalInstallation): void {
  if (p.uefi) validateUefi(p.uefi);
  for (const artifact of [p.kernel, p.initrd]) {
    const url = new URL(artifact.url);
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.hash,
      "boot artifacts require HTTPS URLs without credentials or fragments");
    requireValue(/^[a-f0-9]{64}$/.test(artifact.sha256), "boot artifacts require SHA256 pins");
  }
  requireValue(/^[a-z][a-z0-9-]*$/.test(p.suite), "invalid Debian suite");
  requireValue(dnsName.test(p.mirror.hostname) && /^\/[a-zA-Z0-9/._-]*$/.test(p.mirror.directory), "invalid archive mirror");
  requireValue(Number.isInteger(p.rootSizeGiB) && p.rootSizeGiB >= 8, "rootSizeGiB must be at least 8");
  requireValue(Number.isInteger(p.disk.minSizeGiB) && p.disk.minSizeGiB >= p.rootSizeGiB + 4,
    "disk must leave at least 4 GiB beyond root for boot and free extents");
  requireValue(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(p.volumeGroup), "invalid volume group");
  requireValue(!p.disk.serial || /^[a-zA-Z0-9_.:-]{1,128}$/.test(p.disk.serial), "invalid disk serial");
  if (p.disk.eraseSerials !== undefined) {
    requireValue(p.disk.eraseSerials.length > 0 && p.disk.eraseSerials.length <= 16
      && new Set(p.disk.eraseSerials).size === p.disk.eraseSerials.length
      && p.disk.eraseSerials.every(serial => /^[a-zA-Z0-9_.:-]{1,128}$/.test(serial))
      && p.disk.eraseSerials.includes(p.disk.serial ?? ""), "eraseSerials must contain unique exact serials, including the OS disk serial");
  }
  if (p.disk.workloadSerials !== undefined) {
    requireValue(p.disk.workloadSerials.length > 0 && p.disk.workloadSerials.length <= 15
      && new Set(p.disk.workloadSerials).size === p.disk.workloadSerials.length
      && p.disk.workloadSerials.every(serial => serial !== p.disk.serial && p.disk.eraseSerials?.includes(serial)),
    "workloadSerials must be unique additional disks included in eraseSerials");
  }
  requireValue(!p.dnsServers || (p.dnsServers.length > 0 && p.dnsServers.every(ip => isIP(ip))), "invalid resolvers");
  requireValue(p.timeoutSeconds === undefined || (Number.isInteger(p.timeoutSeconds) && p.timeoutSeconds >= 300), "installation timeout must be at least 300 seconds");
}

/** Shared XRD + Composition, following WorkerSetup/EipDnsRecordSetup.
 * provider-kubernetes executes the native resource graph; no custom controller. */
export class BaremetalSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  constructor(scope: Construct, id: string, o: BaremetalSetupOptions) {
    super(scope, id);
    const name = o.name ?? "baremetal-worker";
    const namespace = o.namespace ?? "default";
    validateInstallation(o.installation);
    requireValue(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name), "composition name must be a DNS label of 2–40 characters");
    requireValue(/@sha256:[a-f0-9]{64}$/.test(o.image), "runtime image must be pinned by digest");
    requireValue(Boolean(o.knownHostsSecretName) !== Boolean(o.trustOnFirstUse), "choose a known_hosts Secret or explicitly enable trustOnFirstUse");
    requireValue(o.initialSshAuthentication === undefined || ["privateKey", "password"].includes(o.initialSshAuthentication), "invalid initial SSH authentication");
    requireValue(o.initialSshAuthentication !== "password" || Boolean(o.initialSshSecretName && o.initialSshSecretName !== o.sshSecretName), "password bootstrap requires a separate initial SSH Secret");
    requireValue(Boolean(o.ipv6PodCidrPrefix) === Boolean(o.workloadKubeProviderConfigName), "IPv6 pod allocation and workload ProviderConfig must be configured together");
    if (o.ipv6PodCidrPrefix) requireValue(/^[a-f0-9]{1,4}:[a-f0-9]{1,4}::$/.test(o.ipv6PodCidrPrefix), "pod prefix must be the base of a /32, e.g. 2001:db8::");
    for (const value of [namespace, o.clusterName, o.sshSecretName, o.initialSshSecretName, o.knownHostsSecretName,
      o.kubeProviderConfigName, o.workloadKubeProviderConfigName].filter(Boolean))
      requireValue(dnsName.test(value!) && value!.length <= 63, "invalid resource name");
    requireValue(/^[a-z_][a-z0-9_-]*$/.test(o.initialSshUser ?? "root"), "invalid SSH user");
    requireValue(Number.isInteger(o.initialSshPort ?? 22) && (o.initialSshPort ?? 22) >= 1 && (o.initialSshPort ?? 22) <= 65535, "invalid SSH port");
    validateNode(o.defaults);
    requireValue(Boolean(o.defaults.geo && o.defaults.region && o.defaults.zone), "topology defaults are required");
    requireValue(dnsName.test(o.tagDomain), "invalid tag domain");

    const runtimeFiles = ["agent.py", "host.py", "installer.py", "models.py", "runner.py", "runtime.py", "storage.py", "transport.py", "uefi.py", "validation.py"];
    const scripts = Object.fromEntries(runtimeFiles.map(file => [file, readFileSync(new URL(`./baremetal/${file}`, import.meta.url), "utf8")]));
    const scriptsName = `${name}-${createHash("sha256").update(JSON.stringify(scripts)).digest("hex").slice(0, 16)}`;
    new ApiObject(this, "scripts", { apiVersion: "v1", kind: "ConfigMap", metadata: {
      name: scriptsName, namespace, annotations: { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" },
    }, immutable: true, data: scripts });

    // InjectedIdentity uses this provider SA. The Job gets a separate, per-host
    // Role granting only get/patch on its progress ConfigMap, with no Secret API access.
    const providerSA = o.kubernetesProviderServiceAccount ?? { name: "provider-kubernetes", namespace: "crossplane-system" };
    const rules = [
      { apiGroups: [""], resources: ["configmaps", "serviceaccounts"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
      { apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles", "rolebindings"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
      { apiGroups: ["infrastructure.cluster.x-k8s.io"], resources: ["pooledremotemachines", "remotemachinetemplates"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
      { apiGroups: ["bootstrap.cluster.x-k8s.io"], resources: ["k0sworkerconfigtemplates"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
      { apiGroups: ["cluster.x-k8s.io"], resources: ["machinedeployments"], verbs: ["get", "list", "watch", "create", "update", "patch"] },
    ];
    new ApiObject(this, "provider-role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name, namespace }, rules });
    new ApiObject(this, "provider-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name, namespace },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name }, subjects: [{ kind: "ServiceAccount", ...providerSA }] });

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: { name: "xbaremetalworkers.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: {
        group: "nebula.io", names: { kind: "XBaremetalWorker", plural: "xbaremetalworkers" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        defaultCompositionUpdatePolicy: CompositeResourceDefinitionV2SpecDefaultCompositionUpdatePolicy.MANUAL,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: {
          type: "object", properties: {
            spec: { type: "object", required: ["address"], properties: {
              address: { type: "string", minLength: 7, maxLength: 15,
                pattern: "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$" },
              hostname: { type: "string", minLength: 1, maxLength: 63, pattern: hostnamePattern },
              sshUser: { type: "string", minLength: 1, maxLength: 32, pattern: sshUserPattern },
              sshPort: { type: "integer", minimum: 1, maximum: 65535 },
              geo: { type: "string", minLength: 1, maxLength: 63, pattern: labelPattern },
              region: { type: "string", minLength: 1, maxLength: 63, pattern: labelPattern },
              zone: { type: "string", minLength: 1, maxLength: 63, pattern: labelPattern },
              nodeLabels: { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 63, pattern: `^$|${labelPattern}` },
                "x-kubernetes-validations": [{ rule: "self.all(k, k.size() <= 253 && k.matches('^[A-Za-z0-9_./-]+$'))", message: "invalid node label key" }] },
              taints: { type: "array", maxItems: 64, items: { type: "string", maxLength: 253, pattern: taintPattern } },
            }, "x-kubernetes-validations": [
              { rule: "self.address == oldSelf.address", message: "host address is immutable" },
              ...["hostname", "sshUser", "sshPort"].map(field => ({
                rule: `has(self.${field}) == has(oldSelf.${field}) && (!has(self.${field}) || self.${field} == oldSelf.${field})`,
                message: `${field} is immutable`,
              })),
            ] },
            status: { type: "object", properties: {
              phase: { type: "string" }, osReady: { type: "boolean" }, workerReady: { type: "boolean" }, uefiReady: { type: "boolean" },
              address: { type: "string" }, hostname: { type: "string" }, ipv6PodCidr: { type: "string" },
              lastError: { type: "string" }, requestHash: { type: "string" },
              admissionPublished: { type: "boolean" }, enrollmentPublished: { type: "boolean" },
            } },
          },
        } } }],
      },
    });
    const enrollment = baremetalEnrollmentManifests(o, {
      ...o.defaults, name: "NEBULA_HOSTNAME", address: "NEBULA_ADDRESS", sshUser: "root", sshPort: o.initialSshPort ?? 22,
    }, { dualStack: o.installation.dualStack !== false, labelArg: "NEBULA_LABELS", taintArg: "NEBULA_TAINT_ARGS" });
    this.composition = new Composition(this, "composition", {
      metadata: { name, annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: { compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XBaremetalWorker" }, mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "install-and-enroll", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline",
          inline: { template: baremetalWorkerTemplate({ namespace, clusterName: o.clusterName, tagDomain: o.tagDomain, defaults: o.defaults, image: o.image, scriptsName, enrollment,
            kubeProviderConfigName: o.kubeProviderConfigName ?? "kubernetes-provider-config",
            workloadKubeProviderConfigName: o.workloadKubeProviderConfigName, ipv6PodCidrPrefix: o.ipv6PodCidrPrefix,
            installation: { ...o.installation, dualStack: o.installation.dualStack ?? true, timeoutSeconds: o.installation.timeoutSeconds ?? 3600 },
            ssh: { user: o.initialSshUser ?? "root", port: o.initialSshPort ?? 22,
              authentication: o.initialSshAuthentication ?? "privateKey",
              secretName: o.initialSshSecretName ?? o.sshSecretName, workerSecretName: o.sshSecretName,
              ...(o.knownHostsSecretName ? { knownHostsSecretName: o.knownHostsSecretName } : { trustOnFirstUse: true }) },
          }) },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}
