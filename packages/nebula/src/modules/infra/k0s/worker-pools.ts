import type { Construct } from "constructs";
import { createHash } from "node:crypto";
import { MachineDeploymentV1Beta1 } from "#imports/cluster.x-k8s.io";
import { K0sWorkerConfigTemplateV1Beta2 } from "#imports/bootstrap.cluster.x-k8s.io";
import type { K0sInfraProvider } from "./cluster";

/** A Kubernetes node taint (key[=value]:Effect). */
export interface NodeTaint {
  key: string;
  value?: string;
  /** e.g. "NoSchedule", "NoExecute", "PreferNoSchedule". */
  effect: string;
}

/**
 * Lets the Kubernetes cluster-autoscaler (Cluster API provider) size a pool.
 * The MachineDeployment carries the autoscaler's min/max annotations and no
 * replica count of its own: Cluster API defaults a new one to `minSize`, and
 * the autoscaler owns it from there. `minSize: 0` means the pool is empty
 * while nothing needs it; the infrastructure template's `status.capacity`
 * (set by CAPA from the instance type) and the pool's labels and taints let
 * the autoscaler plan a node it has never seen.
 */
export interface K0sWorkerPoolAutoscaling {
  /** Fewest nodes, 0 for scale-to-zero. */
  minSize: number;
  /** Most nodes. */
  maxSize: number;
  /**
   * What a node of this pool offers, for planning one from zero. CAPA fills
   * cpu and memory on the machine template; the disk it does not, and a pod
   * that requests ephemeral storage never fits a node planned without any
   * (observed live: every runner pod "can't be scheduled ... NodeResourcesFit"
   * against an otherwise correct pool). Give `ephemeralDisk` the allocatable
   * disk, a little under the root volume.
   */
  capacity?: {
    /** Allocatable ephemeral storage, e.g. "140Gi". */
    ephemeralDisk?: string;
    cpu?: string;
    memory?: string;
    maxPods?: number;
  };
}

/**
 * A worker pool. Provider-agnostic except for `machine` — the infrastructure
 * machine spec (`M`) the provider understands (e.g. AWS instanceType/ami/spot).
 */
export interface K0sWorkerPool<M> {
  /** Number of worker nodes (static). Default 2. Ignored with `autoscaling`. */
  replicas?: number;
  /** Size the pool by demand instead of `replicas`; see {@link K0sWorkerPoolAutoscaling}. */
  autoscaling?: K0sWorkerPoolAutoscaling;
  /** Node labels, applied via the native `k0s worker --labels` flag. */
  nodeLabels?: Record<string, string>;
  /** Node taints, applied via the native `k0s worker --taints` flag. */
  taints?: NodeTaint[];
  /** Extra raw `k0s worker` args (appended after --labels/--taints). */
  k0sArgs?: string[];
  /** Extra cloud-init preStartCommands appended to the defaults. */
  extraPreStartCommands?: string[];
  /** CAPI failureDomain (e.g. an AZ name) to pin the pool's Machines to. */
  failureDomain?: string;
  /** Provider-specific machine spec (instanceType/ami/… for AWS). */
  machine: M;
}

function workerSchedulingValues<M>(pool: K0sWorkerPool<M>): { labels: string; taints: string } {
  const labels = Object.entries(pool.nodeLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  const taints = (pool.taints ?? []).map(({ key, value, effect }) =>
    value === undefined ? `${key}:${effect}` : `${key}=${value}:${effect}`
  );
  return { labels: labels.join(","), taints: taints.join(",") };
}

const AUTOSCALER_ANNOTATION = "cluster.x-k8s.io/cluster-api-autoscaler-node-group";
const CAPACITY_ANNOTATION = "capacity.cluster-autoscaler.kubernetes.io";

/**
 * The cluster-autoscaler annotations of an autoscaled pool's
 * MachineDeployment, or undefined for a static pool.
 */
export function autoscalerAnnotations<M>(pool: K0sWorkerPool<M>): Record<string, string> | undefined {
  const scaling = pool.autoscaling;
  if (!scaling) return undefined;
  if (!Number.isInteger(scaling.minSize) || !Number.isInteger(scaling.maxSize) || scaling.minSize < 0 || scaling.maxSize < scaling.minSize) {
    throw new Error(`autoscaling: 0 <= minSize (${scaling.minSize}) <= maxSize (${scaling.maxSize})`);
  }
  const { labels, taints } = workerSchedulingValues(pool);
  const capacity = scaling.capacity ?? {};
  return {
    [`${AUTOSCALER_ANNOTATION}-min-size`]: String(scaling.minSize),
    [`${AUTOSCALER_ANNOTATION}-max-size`]: String(scaling.maxSize),
    ...(labels ? { [`${CAPACITY_ANNOTATION}/labels`]: labels } : {}),
    ...(taints ? { [`${CAPACITY_ANNOTATION}/taints`]: taints } : {}),
    ...(capacity.ephemeralDisk ? { [`${CAPACITY_ANNOTATION}/ephemeral-disk`]: capacity.ephemeralDisk } : {}),
    ...(capacity.cpu ? { [`${CAPACITY_ANNOTATION}/cpu`]: capacity.cpu } : {}),
    ...(capacity.memory ? { [`${CAPACITY_ANNOTATION}/memory`]: capacity.memory } : {}),
    ...(capacity.maxPods !== undefined ? { [`${CAPACITY_ANNOTATION}/maxPods`]: String(capacity.maxPods) } : {}),
  };
}

/**
 * Default cloud-init preStartCommands, shared by the control-plane and every
 * worker pool.
 *
 * Deliberately just the inotify limits. This used to also `apt-get install`
 * linux-headers + lvm2 + thin-provisioning-tools + open-iscsi + cryptsetup and
 * enable iscsid, for a Piraeus/LINSTOR stack that no longer exists anywhere in
 * the estate — every node paid an archive fetch and a kernel-header install at
 * boot for a DRBD transport nothing was going to use. A pool that genuinely
 * needs host storage packages asks for them through `extraPreStartCommands`,
 * where the reason is visible next to the cluster that has it.
 */
export const DEFAULT_PRESTART_COMMANDS: readonly string[] = [
  "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
];

/** Keep legacy names; give opt-in host checks their own bootstrap template. */
export function hostBootstrapTemplateName(base: string, commands: readonly string[]): string {
  return commands.length ? `${base.slice(0, 50)}-${createHash("sha256").update(JSON.stringify(commands)).digest("hex").slice(0, 12)}` : base;
}

/**
 * preK0sCommands recording the node's own addresses for `--node-ip`, keyed off
 * the default-route interface so no metadata service is involved.
 *
 * Required on every DUAL-STACK worker from k0s 1.35 on. Given a dual-stack
 * cluster and no explicit `--node-ip`, the worker resolves the kubelet's node
 * NAME through DNS and demands one address of each family back
 * (k0sproject/k0s#5840, pkg/component/worker/kubelet.go). Under Cluster API
 * the node name is the Machine name, which is in no DNS zone, so the lookup
 * returns nothing and k0s exits before the kubelet ever contacts the API
 * server:
 *
 *   failed to detect node IPs for "cicd-amd64-sgxxq-nmfpt":
 *   lookup cicd-amd64-sgxxq-nmfpt on 127.0.0.53:53: server misbehaving
 *
 * k0s 1.34 only logged that failure. Passing the addresses is upstream's own
 * documented way out, and it is per-node without a per-node template: the
 * substitutions run on the node, and `k0s install worker` bakes the resolved
 * literals into the systemd unit.
 *
 * The v6 GUA arrives by RA/DHCPv6, so that read waits for it instead of
 * assuming it has landed by the time cloud-init reaches this point. Missing
 * addresses fail bootstrap; never join with an empty second --node-ip family.
 * Read the NIC addresses, not a cloud public-IPv4 NAT/EIP identity.
 */
export const NODE_IP_DISCOVERY_COMMANDS: readonly string[] = [
  `sh -ec 'IFACE=$(ip -4 route show default | awk "{print \\$5}" | head -1); test -n "$IFACE" || { echo "dual-stack bootstrap: no IPv4 default-route interface" >&2; exit 1; }; IP4=$(ip -4 addr show dev "$IFACE" scope global | awk "/inet /{print \\$2; exit}" | cut -d/ -f1); test -n "$IP4" || { echo "dual-stack bootstrap: no on-link IPv4 address on $IFACE" >&2; exit 1; }; echo "$IP4" > /run/node-ip'`,
  `sh -ec 'IFACE=$(ip -4 route show default | awk "{print \\$5}" | head -1); test -n "$IFACE" || { echo "dual-stack bootstrap: no IPv4 default-route interface" >&2; exit 1; }; for i in $(seq 1 30); do IP6=$(ip -6 addr show dev "$IFACE" scope global 2>/dev/null | awk "/inet6/ && !/ tentative| dadfailed| deprecated/{print \\$2; exit}" | cut -d/ -f1); if [ -n "$IP6" ]; then echo "$IP6" > /run/node-ip6; exit 0; fi; sleep 2; done; echo "dual-stack bootstrap: no usable on-link IPv6 address on $IFACE after 60 seconds; configure IPv6 before joining" >&2; exit 1'`,
];

/** Previous NIC discovery bytes for retained worker templates. Use only when
 * preserving a qualified bootstrap during module adoption. Unlike the default
 * checked discovery, this preset can write an empty or tentative IPv6 address;
 * switching to checked discovery is a separate worker rollout. */
export const RETAINED_NIC_NODE_IP_DISCOVERY_COMMANDS: readonly string[] = [
  `sh -c 'IFACE=$(ip route show default | awk "{print \\$5}" | head -1); ip -4 addr show dev "$IFACE" scope global | awk "/inet /{print \\$2; exit}" | cut -d/ -f1 > /run/node-ip'`,
  `sh -c 'IFACE=$(ip route show default | awk "{print \\$5}" | head -1); for i in $(seq 1 30); do IP6=$(ip -6 addr show dev "$IFACE" scope global 2>/dev/null | awk "/inet6/{print \\$2; exit}" | cut -d/ -f1); [ -n "$IP6" ] && break; sleep 2; done; echo "$IP6" > /run/node-ip6'`,
];

/**
 * Add `--node-ip` (from {@link NODE_IP_DISCOVERY_COMMANDS}) to a worker's k0s
 * args, folding it into an existing `--kubelet-extra-args` rather than adding
 * a second one — k0s keeps only the last occurrence, so a naive append would
 * discard whatever the pool had set. A pool that already states `--node-ip`
 * is left alone.
 */
export function withNodeIpArgs(args: string[]): string[] {
  const nodeIp = "--node-ip=$(cat /run/node-ip),$(cat /run/node-ip6)";
  const prefix = "--kubelet-extra-args=";
  const i = args.findIndex((a) => a.startsWith(prefix));
  if (i < 0) return [...args, `${prefix}"${nodeIp}"`];
  const existing = args[i].slice(prefix.length).replace(/^"|"$/g, "");
  if (existing.includes("--node-ip=")) return args;
  const merged = [...args];
  merged[i] = `${prefix}"${nodeIp} ${existing}"`;
  return merged;
}

/** Render `k0s worker` --labels/--taints args from a pool's labels/taints. */
export function renderK0sWorkerArgs<M>(pool: K0sWorkerPool<M>): string[] {
  const { labels, taints } = workerSchedulingValues(pool);
  return [
    ...(labels ? [`--labels=${labels}`] : []),
    ...(taints ? [`--taints=${taints}`] : []),
    ...(pool.k0sArgs ?? []),
  ];
}

interface ClusterWorkerPools<M> {
  clusterName: string;
  namespace: string;
  k8sVersion: string;
  provider: K0sInfraProvider<M>;
  pools?: Record<string, K0sWorkerPool<M>>;
  /** Defined for dual-stack workers, including those supplying their own discovery. */
  nodeIpDiscoveryCommands?: readonly string[];
  nodeDrainTimeout?: string;
}

/** Emit each pool directly under the cluster to preserve its construct paths. */
export function emitWorkerPools<M>(scope: Construct, config: ClusterWorkerPools<M>): void {
  const { clusterName, namespace, k8sVersion, provider, nodeIpDiscoveryCommands, nodeDrainTimeout } = config;
  for (const [poolName, pool] of Object.entries(config.pools ?? {})) {
    const name = `${clusterName}-${poolName}`;
    const infraRef = provider.emitMachineTemplate(scope, `worker-template-${poolName}`, {
      baseName: name,
      namespace,
      role: "worker",
      machine: pool.machine,
    });

    const hostCommands = provider.hostPreK0sCommands?.(pool.machine, "worker") ?? [];
    const workerConfigName = hostBootstrapTemplateName(`${name}-config`, hostCommands);
    const poolArgs = renderK0sWorkerArgs(pool);
    const args = nodeIpDiscoveryCommands === undefined ? poolArgs : withNodeIpArgs(poolArgs);
    new K0sWorkerConfigTemplateV1Beta2(scope, `worker-config-${poolName}`, {
      metadata: { name: workerConfigName, namespace },
      spec: {
        template: {
          spec: {
            version: `${k8sVersion}+k0s.0`,
            ...(args.length ? { args } : {}),
            preK0SCommands: [
              ...hostCommands,
              ...DEFAULT_PRESTART_COMMANDS,
              ...(nodeIpDiscoveryCommands ?? []),
              ...(pool.extraPreStartCommands ?? []),
            ],
          },
        },
      },
    });

    const annotations = autoscalerAnnotations(pool);
    new MachineDeploymentV1Beta1(scope, `worker-md-${poolName}`, {
      metadata: { name, namespace, ...(annotations ? { annotations } : {}) },
      spec: {
        clusterName,
        ...(annotations ? {} : { replicas: pool.replicas ?? 2 }),
        selector: {
          matchLabels: { "cluster.x-k8s.io/cluster-name": clusterName },
        },
        template: {
          spec: {
            clusterName,
            version: k8sVersion,
            ...(nodeDrainTimeout ? { nodeDrainTimeout } : {}),
            ...(pool.failureDomain ? { failureDomain: pool.failureDomain } : {}),
            bootstrap: {
              configRef: {
                apiVersion: "bootstrap.cluster.x-k8s.io/v1beta2",
                kind: "K0sWorkerConfigTemplate",
                name: workerConfigName,
              },
            },
            infrastructureRef: {
              apiVersion: infraRef.apiVersion,
              kind: infraRef.kind,
              name: infraRef.name,
            },
          },
        },
      },
    });
  }
}
