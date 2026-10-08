import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { baremetalWorkerManifests, type BaremetalFleetOptions, type BaremetalNode } from "../k0s/baremetal";
import { NODE_IP_DISCOVERY_COMMANDS } from "../k0s/cluster";

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

export interface SshBaremetalFleetOptions extends BaremetalFleetOptions {
  installation: SshBaremetalInstallation;
  /** Initial access; defaults to the k0smotron worker key. Passwords are unsupported. */
  initialSshSecretName?: string;
  initialSshUser?: string;
  initialSshPort?: number;
  /** Secret key `known_hosts`. Omission requires explicit trustOnFirstUse. */
  knownHostsSecretName?: string;
  trustOnFirstUse?: boolean;
  defaults: Pick<BaremetalNode, "geo" | "region" | "zone" | "nodeLabels" | "taints">;
  /** A dedicated /32 IPv6 pod range. The IPv4 address supplies the remaining
   * 32 bits of each /64, independent of inventory ordering. */
  ipv6PodCidrPrefix?: string;
  /** CAPI workload kubeconfig Secret (key `value`), required with the pod prefix.
   * The controller installs exact-host admission before publishing the pool. */
  workloadKubeconfigSecretName?: string;
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

/** SSH-only fresh OS installation followed by the existing pooled CAPI graph.
 * The declaration itself never publishes a reservable pool entry. */
export class SshBaremetalFleet extends Construct {
  public readonly hosts: ApiObject[] = [];
  public readonly nodes: Array<BaremetalNode & { ipv6PodCidr?: string }> = [];
  private readonly addresses = new Set<string>();
  constructor(scope: Construct, id: string, private readonly options: SshBaremetalFleetOptions) {
    super(scope, id);
    validateInstallation(options.installation);
    requireValue(Boolean(options.knownHostsSecretName) !== Boolean(options.trustOnFirstUse),
      "choose a known_hosts Secret or explicitly enable trustOnFirstUse");
    requireValue(Boolean(options.ipv6PodCidrPrefix) === Boolean(options.workloadKubeconfigSecretName),
      "IPv6 pod allocation and workload kubeconfig must be configured together");
    if (options.ipv6PodCidrPrefix) requireValue(/^[a-f0-9]{1,4}:[a-f0-9]{1,4}::$/.test(options.ipv6PodCidrPrefix), "pod prefix must be the base of a /32, e.g. 2001:db8::");
    for (const name of [options.clusterName, options.sshSecretName, options.namespace ?? "default",
      options.initialSshSecretName, options.knownHostsSecretName, options.workloadKubeconfigSecretName].filter(Boolean))
      requireValue(dnsName.test(name!) && name!.length <= 63, "invalid resource name");
    requireValue(/^[a-z_][a-z0-9_-]*$/.test(options.initialSshUser ?? "root"), "invalid SSH user");
    requireValue(Number.isInteger(options.initialSshPort ?? 22) && (options.initialSshPort ?? 22) >= 1 && (options.initialSshPort ?? 22) <= 65535, "invalid SSH port");
    for (const value of [options.defaults.geo, options.defaults.region, options.defaults.zone])
      requireValue(labelValue.test(value) && value.length <= 63, "invalid topology label");
    requireValue(dnsName.test(options.tagDomain), "invalid tag domain");
    for (const [key, value] of Object.entries(options.defaults.nodeLabels ?? {}))
      requireValue(/^[A-Za-z0-9_.\/-]+$/.test(key) && (!value || labelValue.test(value)), "invalid node label");
    for (const taint of options.defaults.taints ?? [])
      requireValue(/^[A-Za-z0-9_.\/-]+(?:=[A-Za-z0-9_.-]+)?:(NoSchedule|NoExecute|PreferNoSchedule)$/.test(taint), "invalid taint");
  }

  addHost(address: string): ApiObject {
    requireValue(isIP(address) === 4, "this installer requires an IPv4 SSH address (installed networking can be dual-stack)");
    requireValue(!this.addresses.has(address), "duplicate host address");
    this.addresses.add(address);
    const o = this.options;
    const name = `bm-${address.replaceAll(".", "-")}`;
    const octets = address.split(".").map(Number);
    const ipv6PodCidr = o.ipv6PodCidrPrefix
      ? `${o.ipv6PodCidrPrefix.slice(0, -1)}${(octets[0] * 256 + octets[1]).toString(16)}:${(octets[2] * 256 + octets[3]).toString(16)}::/64` : undefined;
    const node = { ...o.defaults, name, address, ipv6PodCidr };
    this.nodes.push(node);
    const enrollment: any[] = baremetalWorkerManifests(o, { ...node, sshUser: "root", sshPort: o.initialSshPort ?? 22 });
    if (o.installation.dualStack !== false) {
      const config = enrollment.find(r => r.kind === "K0sWorkerConfigTemplate").spec.template.spec;
      config.preK0sCommands = [config.preK0sCommands[0], ...NODE_IP_DISCOVERY_COMMANDS];
      config.args = config.args.map((arg: string) => arg.replace("--node-ip=$(cat /run/node-ip)", "--node-ip=$(cat /run/node-ip),$(cat /run/node-ip6)"));
    }
    const host = new ApiObject(this, name, {
      apiVersion: "baremetal.nebula.io/v1alpha1", kind: "SshBaremetalHost",
      metadata: { name, namespace: o.namespace ?? "default", annotations: {
        "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      } },
      spec: {
        address, hostname: name,
        ssh: { user: o.initialSshUser ?? "root", port: o.initialSshPort ?? 22,
          secretName: o.initialSshSecretName ?? o.sshSecretName,
          workerSecretName: o.sshSecretName,
          ...(o.knownHostsSecretName ? { knownHostsSecretName: o.knownHostsSecretName } : { trustOnFirstUse: true }) },
        installation: { ...o.installation, dualStack: o.installation.dualStack ?? true, timeoutSeconds: o.installation.timeoutSeconds ?? 3600 },
        ...(ipv6PodCidr ? { ipv6PodCidr, workloadKubeconfigSecretName: o.workloadKubeconfigSecretName } : {}),
        enrollment,
      },
    });
    this.hosts.push(host);
    return host;
  }
}

export interface SshBaremetalProvisionerOptions {
  namespace: string;
  /** Image built from this module's Dockerfile. Require an immutable digest. */
  image: string;
  /** Exact Secret names the controller may read in this namespace. */
  secretNames: string[];
  name?: string;
}

/** Install once per namespace. No provider credentials, BMC, DHCP or PXE service. */
export class SshBaremetalProvisioner extends Construct {
  constructor(scope: Construct, id: string, o: SshBaremetalProvisionerOptions) {
    super(scope, id);
    const name = o.name ?? "ssh-baremetal-provisioner";
    requireValue(dnsName.test(name) && name.length <= 63 && dnsName.test(o.namespace) && o.namespace.length <= 63, "invalid controller name or namespace");
    requireValue(/@sha256:[a-f0-9]{64}$/.test(o.image), "controller image must be pinned by digest");
    requireValue(o.secretNames.length > 0 && o.secretNames.every(n => dnsName.test(n)), "explicit SSH/known_hosts/workload secret allowlist required");
    const meta = { name, namespace: o.namespace };
    new ApiObject(this, "crd", {
      apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition",
      metadata: { name: "sshbaremetalhosts.baremetal.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: { group: "baremetal.nebula.io", scope: "Namespaced", names: { kind: "SshBaremetalHost", plural: "sshbaremetalhosts", singular: "sshbaremetalhost", shortNames: ["sshbmh"] },
        versions: [{ name: "v1alpha1", served: true, storage: true, subresources: { status: {} },
          additionalPrinterColumns: [{ name: "Address", type: "string", jsonPath: ".spec.address" }, { name: "Phase", type: "string", jsonPath: ".status.phase" }],
          schema: { openAPIV3Schema: { type: "object", properties: {
            spec: { type: "object", required: ["address", "hostname", "ssh", "installation", "enrollment"], properties: {
              address: { type: "string", maxLength: 15 }, hostname: { type: "string", maxLength: 63 },
              ssh: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
              installation: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
              ipv6PodCidr: { type: "string" }, workloadKubeconfigSecretName: { type: "string" },
              enrollment: { type: "array", maxItems: 4, minItems: 4, items: { type: "object", "x-kubernetes-preserve-unknown-fields": true } },
            }, "x-kubernetes-validations": [
              { rule: "self.address == oldSelf.address && self.hostname == oldSelf.hostname", message: "host identity is immutable" },
            ] },
            status: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
          } } },
        }] },
    });
    const scripts = Object.fromEntries(["controller.py", "installer.py", "host.py"].map(file => [file, readFileSync(new URL(`./${file}`, import.meta.url), "utf8")]));
    new ApiObject(this, "scripts", { apiVersion: "v1", kind: "ConfigMap", metadata: meta, data: scripts });
    new ApiObject(this, "service-account", { apiVersion: "v1", kind: "ServiceAccount", metadata: meta });
    new ApiObject(this, "role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: meta, rules: [
      { apiGroups: ["baremetal.nebula.io"], resources: ["sshbaremetalhosts"], verbs: ["get", "list", "patch"] },
      { apiGroups: ["baremetal.nebula.io"], resources: ["sshbaremetalhosts/status"], verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["secrets"], resourceNames: [...new Set(o.secretNames)], verbs: ["get"] },
      { apiGroups: ["infrastructure.cluster.x-k8s.io"], resources: ["pooledremotemachines", "remotemachinetemplates"], verbs: ["get", "create", "patch"] },
      { apiGroups: ["bootstrap.cluster.x-k8s.io"], resources: ["k0sworkerconfigtemplates"], verbs: ["get", "create", "patch"] },
      { apiGroups: ["cluster.x-k8s.io"], resources: ["machinedeployments"], verbs: ["get", "create", "patch"] },
    ] });
    new ApiObject(this, "role-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: meta,
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name }, subjects: [{ kind: "ServiceAccount", ...meta }] });
    new ApiObject(this, "deployment", { apiVersion: "apps/v1", kind: "Deployment", metadata: meta,
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: name } }, template: {
        metadata: { labels: { app: name }, annotations: { "baremetal.nebula.io/scripts": createHash("sha256").update(JSON.stringify(scripts)).digest("hex") } },
        spec: { serviceAccountName: name, securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "controller", image: o.image, command: ["python3", "-B", "/opt/provisioner/controller.py"],
            env: [{ name: "NAMESPACE", value: o.namespace }], resources: { requests: { cpu: "50m", memory: "128Mi" } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            volumeMounts: [{ name: "scripts", mountPath: "/opt/provisioner", readOnly: true }, { name: "scratch", mountPath: "/tmp" }],
          }], volumes: [{ name: "scripts", configMap: { name } }, { name: "scratch", emptyDir: { medium: "Memory", sizeLimit: "512Mi" } }],
        },
      } },
    });
  }
}
