/** CAPI enrollment for externally owned hosts. The caller declares stable
 * host inventory and prepares SSH access; remediation reuses that host and
 * hostname, preserving local-volume node affinity. */
import { Construct } from "constructs";
import {
  MachineDeploymentV1Beta2,
  MachineDeploymentV1Beta2SpecRolloutStrategyType,
  MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxSurge,
  MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxUnavailable,
} from "#imports/cluster.x-k8s.io";
import {
  PooledRemoteMachineV1Beta2,
  RemoteMachineTemplateV1Beta2,
} from "#imports/infrastructure.cluster.x-k8s.io";
import { K0sWorkerConfigTemplateV1Beta2 } from "#imports/bootstrap.cluster.x-k8s.io";

export interface BaremetalFleetOptions {
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
}

export interface BaremetalNode {
  /** Node name — MUST equal the host's hostname (useSystemHostname). */
  name: string;
  /** The host's public address — static, git-safe (unlike cloud addresses). */
  address: string;
  /** SSH user (default "root" — baremetal images keep root logins). */
  sshUser?: string;
  sshPort?: number;
  /** Short geo tag for the estate-wide geo label, e.g. "eu". */
  geo: string;
  /** topology.kubernetes.io/region, e.g. the DC location ("hel1"). */
  region: string;
  /** topology.kubernetes.io/zone (Hetzner has no zones — repeat the DC). */
  zone: string;
  nodeLabels?: Record<string, string>;
  /** Raw --register-with-taints entries, e.g. "workload=x:NoSchedule". */
  taints?: string[];
}

/**
 * One baremetal node: static SSH inventory + the CAPI adoption chain.
 * Mirrors AwsWorkerFleet.addCapiAdoption.
 */
export function baremetalWorker(
  scope: Construct,
  o: BaremetalFleetOptions,
  node: BaremetalNode,
): void {
  const ns = o.namespace ?? "default";
  const user = node.sshUser ?? "root";

  // The pooled inventory entry, git-static. Pool of one, pool == node name:
  // the reservation is deterministic and CAPI's controller ownerReference
  // lands on the RemoteMachine, never on inventory.
  new PooledRemoteMachineV1Beta2(scope, `${node.name}-pooled-machine`, {
    metadata: { name: node.name, namespace: ns },
    spec: {
      pool: node.name,
      machine: {
        address: node.address,
        port: node.sshPort ?? 22,
        user,
        useSudo: user !== "root",
        sshKeyRef: { name: o.sshSecretName },
      },
    },
  });

  new RemoteMachineTemplateV1Beta2(scope, `${node.name}-remote-machine-template`, {
    metadata: { name: node.name, namespace: ns },
    spec: { template: { spec: { pool: node.name } } },
  });

  const labels = {
    ...node.nodeLabels,
    [`${o.tagDomain}/geo`]: node.geo,
    "topology.kubernetes.io/region": node.region,
    "topology.kubernetes.io/zone": node.zone,
  };
  const labelArg = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const kubeletArgs = [
    // Explicit --node-ip: from k0s 1.35 a worker without one resolves its
    // node NAME through DNS, which a bare host's hostname never satisfies.
    // Discovered from the default-route interface at provision time so the
    // address literal in this file stays in exactly one place (the pool).
    "--node-ip=$(cat /run/node-ip)",
    ...(node.taints?.length
      ? [`--register-with-taints=${node.taints.join(",")}`]
      : []),
  ].join(" ");
  new K0sWorkerConfigTemplateV1Beta2(scope, `${node.name}-worker-config-template`, {
    metadata: { name: node.name, namespace: ns },
    spec: {
      template: {
        spec: {
          version: o.k0sVersion,
          // The enrollment contract set the hostname; without this the
          // bootstrap provider would rename the host to the randomly-suffixed
          // Machine name on every remediation.
          useSystemHostname: true,
          preK0SCommands: [
            "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
            `sh -c 'IFACE=$(ip route show default | awk "{print \\$5}" | head -1); ip -4 addr show dev "$IFACE" scope global | awk "/inet /{print \\$2; exit}" | cut -d/ -f1 > /run/node-ip'`,
          ],
          // Labels through k0s's own --labels flag, never kubelet-extra-args'
          // --node-labels: k0s resolves that collision by dropping its
          // injected k0smotron.io/machine-name label, without which the
          // ProviderIDController cannot match Machines to host-named nodes
          // (see the AWS fleet for the incident).
          args: [
            `--labels=${labelArg}`,
            `--kubelet-extra-args="${kubeletArgs}"`,
          ],
        },
      },
    },
  });

  const nodeLabelKey = `${o.tagDomain}/node`;
  new MachineDeploymentV1Beta2(scope, `${node.name}-machine-deployment`, {
    metadata: {
      name: node.name,
      namespace: ns,
      labels: { "cluster.x-k8s.io/cluster-name": o.clusterName },
    },
    spec: {
      clusterName: o.clusterName,
      replicas: 1,
      selector: { matchLabels: { [nodeLabelKey]: node.name } },
      rollout: {
        strategy: {
          type: MachineDeploymentV1Beta2SpecRolloutStrategyType.ROLLING_UPDATE,
          // maxSurge MUST stay 0: a surge Machine waits forever on the
          // single-entry pool.
          rollingUpdate: {
            maxSurge:
              MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxSurge.fromNumber(0),
            maxUnavailable:
              MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxUnavailable.fromNumber(1),
          },
        },
      },
      template: {
        metadata: {
          labels: {
            [nodeLabelKey]: node.name,
            "cluster.x-k8s.io/cluster-name": o.clusterName,
          },
        },
        spec: {
          clusterName: o.clusterName,
          version: o.k0sVersion.split("+")[0],
          // Bound the drain so a single-replica PDB cannot hold a machine
          // deletion open forever (see the AWS fleet for the incident).
          deletion: { nodeDrainTimeoutSeconds: 300 },
          bootstrap: {
            configRef: {
              apiGroup: "bootstrap.cluster.x-k8s.io",
              kind: "K0sWorkerConfigTemplate",
              name: node.name,
            },
          },
          infrastructureRef: {
            apiGroup: "infrastructure.cluster.x-k8s.io",
            kind: "RemoteMachineTemplate",
            name: node.name,
          },
        },
      },
    },
  });
}

/** A shared configuration for multiple externally owned worker hosts. */
export class BaremetalFleet extends Construct {
  constructor(scope: Construct, id: string, private readonly options: BaremetalFleetOptions) {
    super(scope, id);
  }
  addNode(node: BaremetalNode): void {
    baremetalWorker(this, this.options, node);
  }
}
