import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import {
  CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope,
  Composition, CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { baremetalWorkerManifests, type BaremetalFleetOptions, type BaremetalNode } from "../k0s/baremetal";
import { NODE_IP_DISCOVERY_COMMANDS } from "../k0s/cluster";
import { sshBaremetalTemplate } from "./template";

export interface BaremetalBootArtifact { url: string; sha256: string }

/** Shared installation policy, independent of the server supplier. */
export interface SshBaremetalInstallation {
  /** Debian amd64 netboot kernel and initrd, from the same installer release. */
  kernel: BaremetalBootArtifact;
  initrd: BaremetalBootArtifact;
  suite: string;
  /** Debian archive hostname and path. Signed archive verification stays enabled. */
  mirror: { hostname: string; directory: string };
  /** Existing root disk is selected only when it resolves to ONE physical disk.
   * An exact serial can select a disk on multi-disk hosts. RAID is refused. */
  disk: { serial?: string; minSizeGiB: number };
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

export interface SshBaremetalSetupOptions extends BaremetalFleetOptions {
  /** Shared Composition name, selected by each host XR. */
  name?: string;
  /** Runtime image built from this module's Dockerfile, pinned by digest. */
  image: string;
  installation: SshBaremetalInstallation;
  initialSshSecretName?: string;
  initialSshUser?: string;
  initialSshPort?: number;
  /** Secret key known_hosts; HostKeyAlias is the derived bm-<IPv4> hostname. */
  knownHostsSecretName?: string;
  trustOnFirstUse?: boolean;
  defaults: Pick<BaremetalNode, "geo" | "region" | "zone" | "nodeLabels" | "taints">;
  /** Optional dedicated /32. Each IPv4 deterministically supplies a /64. */
  ipv6PodCidrPrefix?: string;
  /** Existing workload ProviderConfig, used only for native Node admission. */
  workloadKubeProviderConfigName?: string;
  /** Local management-cluster ProviderConfig. */
  kubeProviderConfigName?: string;
  kubernetesProviderServiceAccount?: { name: string; namespace: string };
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`SSH baremetal: ${message}`);
}
const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const labelValue = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/;

function validateInstallation(p: SshBaremetalInstallation): void {
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
  requireValue(!p.dnsServers || (p.dnsServers.length > 0 && p.dnsServers.every(ip => isIP(ip))), "invalid resolvers");
  requireValue(p.timeoutSeconds === undefined || (Number.isInteger(p.timeoutSeconds) && p.timeoutSeconds >= 300), "installation timeout must be at least 300 seconds");
}

export interface SshBaremetalFleetOptions { compositionName?: string }

/** One XRD instance per IP; credentials and installation policy live in the shared Composition. */
export class SshBaremetalFleet extends Construct {
  public readonly hosts: ApiObject[] = [];
  private readonly addresses = new Set<string>();
  constructor(scope: Construct, id: string, private readonly options: SshBaremetalFleetOptions = {}) {
    super(scope, id);
  }
  addHost(address: string): ApiObject {
    requireValue(isIP(address) === 4, "this installer requires an IPv4 SSH address");
    requireValue(!this.addresses.has(address), "duplicate host address");
    this.addresses.add(address);
    const host = new ApiObject(this, `bm-${address.replaceAll(".", "-")}`, {
      apiVersion: "nebula.io/v1alpha1", kind: "XSshBaremetalHost",
      metadata: { name: `bm-${address.replaceAll(".", "-")}`, annotations: {
        "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      } },
      spec: { address, crossplane: {
        compositionRef: { name: this.options.compositionName ?? "ssh-baremetal" },
        // New installation profiles apply to new hosts. Existing hosts retain
        // their reviewed CompositionRevision, including image and script refs.
        compositionUpdatePolicy: "Manual",
      } },
    });
    this.hosts.push(host);
    return host;
  }
}

/** Shared XRD + Composition, following WorkerSetup/EipDnsRecordSetup.
 * provider-kubernetes executes the native resource graph; no custom controller. */
export class SshBaremetalSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  constructor(scope: Construct, id: string, o: SshBaremetalSetupOptions) {
    super(scope, id);
    const name = o.name ?? "ssh-baremetal";
    const namespace = o.namespace ?? "default";
    validateInstallation(o.installation);
    requireValue(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name), "composition name must be a DNS label of 2–40 characters");
    requireValue(/@sha256:[a-f0-9]{64}$/.test(o.image), "runtime image must be pinned by digest");
    requireValue(Boolean(o.knownHostsSecretName) !== Boolean(o.trustOnFirstUse), "choose a known_hosts Secret or explicitly enable trustOnFirstUse");
    requireValue(Boolean(o.ipv6PodCidrPrefix) === Boolean(o.workloadKubeProviderConfigName), "IPv6 pod allocation and workload ProviderConfig must be configured together");
    if (o.ipv6PodCidrPrefix) requireValue(/^[a-f0-9]{1,4}:[a-f0-9]{1,4}::$/.test(o.ipv6PodCidrPrefix), "pod prefix must be the base of a /32, e.g. 2001:db8::");
    for (const value of [namespace, o.clusterName, o.sshSecretName, o.initialSshSecretName, o.knownHostsSecretName,
      o.kubeProviderConfigName, o.workloadKubeProviderConfigName].filter(Boolean))
      requireValue(dnsName.test(value!) && value!.length <= 63, "invalid resource name");
    requireValue(/^[a-z_][a-z0-9_-]*$/.test(o.initialSshUser ?? "root"), "invalid SSH user");
    requireValue(Number.isInteger(o.initialSshPort ?? 22) && (o.initialSshPort ?? 22) >= 1 && (o.initialSshPort ?? 22) <= 65535, "invalid SSH port");
    for (const value of [o.defaults.geo, o.defaults.region, o.defaults.zone])
      requireValue(labelValue.test(value) && value.length <= 63, "invalid topology label");
    requireValue(dnsName.test(o.tagDomain), "invalid tag domain");
    for (const [key, value] of Object.entries(o.defaults.nodeLabels ?? {}))
      requireValue(/^[A-Za-z0-9_.\/-]+$/.test(key) && (!value || labelValue.test(value)), "invalid node label");
    for (const taint of o.defaults.taints ?? [])
      requireValue(/^[A-Za-z0-9_.\/-]+(?:=[A-Za-z0-9_.-]+)?:(NoSchedule|NoExecute|PreferNoSchedule)$/.test(taint), "invalid taint");

    const scripts = Object.fromEntries(["runner.py", "installer.py", "host.py"].map(file => [file, readFileSync(new URL(`./${file}`, import.meta.url), "utf8")]));
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
      metadata: { name: "xsshbaremetalhosts.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: {
        group: "nebula.io", names: { kind: "XSshBaremetalHost", plural: "xsshbaremetalhosts" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: {
          type: "object", properties: {
            spec: { type: "object", required: ["address"], properties: {
              address: { type: "string", minLength: 7, maxLength: 15,
                pattern: "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$" },
            }, "x-kubernetes-validations": [{ rule: "self.address == oldSelf.address", message: "host address is immutable" }] },
            status: { type: "object", properties: {
              phase: { type: "string" }, osReady: { type: "boolean" }, workerReady: { type: "boolean" },
              address: { type: "string" }, hostname: { type: "string" }, ipv6PodCidr: { type: "string" },
              lastError: { type: "string" }, requestHash: { type: "string" },
              admissionPublished: { type: "boolean" }, enrollmentPublished: { type: "boolean" },
            } },
          },
        } } }],
      },
    });
    const enrollment: any[] = baremetalWorkerManifests(o, {
      ...o.defaults, name: "NEBULA_HOSTNAME", address: "NEBULA_ADDRESS", sshUser: "root", sshPort: o.initialSshPort ?? 22,
    });
    if (o.installation.dualStack !== false) {
      const config = enrollment.find(r => r.kind === "K0sWorkerConfigTemplate").spec.template.spec;
      config.preK0sCommands = [config.preK0sCommands[0], ...NODE_IP_DISCOVERY_COMMANDS];
      config.args = config.args.map((arg: string) => arg.replace("--node-ip=$(cat /run/node-ip)", "--node-ip=$(cat /run/node-ip),$(cat /run/node-ip6)"));
    }
    this.composition = new Composition(this, "composition", {
      metadata: { name, annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: { compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XSshBaremetalHost" }, mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "install-and-enroll", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline",
          inline: { template: sshBaremetalTemplate({ namespace, clusterName: o.clusterName, image: o.image, scriptsName, enrollment,
            kubeProviderConfigName: o.kubeProviderConfigName ?? "kubernetes-provider-config",
            workloadKubeProviderConfigName: o.workloadKubeProviderConfigName, ipv6PodCidrPrefix: o.ipv6PodCidrPrefix,
            installation: { ...o.installation, dualStack: o.installation.dualStack ?? true, timeoutSeconds: o.installation.timeoutSeconds ?? 3600 },
            ssh: { user: o.initialSshUser ?? "root", port: o.initialSshPort ?? 22,
              secretName: o.initialSshSecretName ?? o.sshSecretName, workerSecretName: o.sshSecretName,
              ...(o.knownHostsSecretName ? { knownHostsSecretName: o.knownHostsSecretName } : { trustOnFirstUse: true }) },
          }) },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}
