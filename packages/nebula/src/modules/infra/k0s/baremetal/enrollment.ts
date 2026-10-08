import {
  MachineDeploymentV1Beta2,
  type MachineDeploymentV1Beta2Props,
  MachineDeploymentV1Beta2SpecRolloutStrategyType,
  MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxSurge,
  MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxUnavailable,
} from "#imports/cluster.x-k8s.io";
import {
  PooledRemoteMachineV1Beta2,
  type PooledRemoteMachineV1Beta2Props,
  RemoteMachineTemplateV1Beta2,
  type RemoteMachineTemplateV1Beta2Props,
} from "#imports/infrastructure.cluster.x-k8s.io";
import {
  K0sWorkerConfigTemplateV1Beta2,
  type K0sWorkerConfigTemplateV1Beta2Props,
} from "#imports/bootstrap.cluster.x-k8s.io";
import { NODE_IP_DISCOVERY_COMMANDS } from "../cluster";

import type { BaremetalSetupOptions, BaremetalNode } from "../baremetal";

type EnrollmentOptions = Pick<BaremetalSetupOptions,
  "clusterName" | "k0sVersion" | "sshSecretName" | "tagDomain" | "namespace">;
type EnrollmentNode = Required<Pick<BaremetalNode, "name" | "address" | "geo" | "region" | "zone">>
  & Pick<BaremetalNode, "sshUser" | "sshPort" | "nodeLabels" | "taints">;
type BootstrapOptions = { dualStack?: boolean; labelArg?: string; taintArg?: string };

/**
 * Typed CAPI definitions for the worker composition. Apply bootstrap options
 * before the generated serializers run.
 */
function baremetalWorkerProps(
  o: EnrollmentOptions,
  node: EnrollmentNode,
  bootstrap: BootstrapOptions = {},
) {
  const ns = o.namespace ?? "default";
  const user = node.sshUser ?? "root";

  // The pooled inventory entry, git-static. Pool of one, pool == node name:
  // the reservation is deterministic and CAPI's controller ownerReference
  // lands on the RemoteMachine, never on inventory.
  const pooledMachine: PooledRemoteMachineV1Beta2Props = {
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
  };

  const remoteMachineTemplate: RemoteMachineTemplateV1Beta2Props = {
    metadata: { name: node.name, namespace: ns },
    spec: { template: { spec: { pool: node.name } } },
  };

  const labels = {
    ...node.nodeLabels,
    [`${o.tagDomain}/geo`]: node.geo,
    "topology.kubernetes.io/region": node.region,
    "topology.kubernetes.io/zone": node.zone,
  };
  const labelArg = bootstrap.labelArg ?? Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const kubeletArgs = [
    // Explicit --node-ip: from k0s 1.35 a worker without one resolves its
    // node NAME through DNS, which a bare host's hostname never satisfies.
    // Discovered from the default-route interface at provision time so the
    // address literal in this file stays in exactly one place (the pool).
    bootstrap.dualStack
      ? "--node-ip=$(cat /run/node-ip),$(cat /run/node-ip6)"
      : "--node-ip=$(cat /run/node-ip)",
    ...(bootstrap.taintArg ? [bootstrap.taintArg] : node.taints?.length
      ? [`--register-with-taints=${node.taints.join(",")}`]
      : []),
  ].join(" ");
  const workerConfigTemplate: K0sWorkerConfigTemplateV1Beta2Props = {
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
            ...(bootstrap.dualStack ? NODE_IP_DISCOVERY_COMMANDS : [
              `sh -c 'IFACE=$(ip route show default | awk "{print \\$5}" | head -1); ip -4 addr show dev "$IFACE" scope global | awk "/inet /{print \\$2; exit}" | cut -d/ -f1 > /run/node-ip'`,
            ]),
          ],
          // Labels through k0s's own --labels flag, never kubelet-extra-args'
          // --node-labels: k0s resolves that collision by dropping its
          // injected machine-name label, without which the
          // ProviderIDController cannot match Machines to host-named nodes
          // (see the AWS fleet for the incident).
          args: [
            `--labels=${labelArg}`,
            `--kubelet-extra-args="${kubeletArgs}"`,
          ],
        },
      },
    },
  };

  const nodeLabelKey = `${o.tagDomain}/node`;
  const machineDeployment: MachineDeploymentV1Beta2Props = {
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
            maxSurge: MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxSurge.fromNumber(0),
            maxUnavailable: MachineDeploymentV1Beta2SpecRolloutStrategyRollingUpdateMaxUnavailable.fromNumber(1),
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
  };
  return { pooledMachine, remoteMachineTemplate, workerConfigTemplate, machineDeployment };
}

/** Serialize typed definitions for embedding in a Crossplane composition.
 * Generated manifest() methods apply schema field names and union conversions
 * without adding live enrollment objects to the setup chart. */
export function baremetalEnrollmentManifests(
  o: EnrollmentOptions,
  node: EnrollmentNode,
  bootstrap: BootstrapOptions = {},
): readonly Record<string, unknown>[] {
  const props = baremetalWorkerProps(o, node, bootstrap);
  return [
    PooledRemoteMachineV1Beta2.manifest(props.pooledMachine),
    RemoteMachineTemplateV1Beta2.manifest(props.remoteMachineTemplate),
    K0sWorkerConfigTemplateV1Beta2.manifest(props.workerConfigTemplate),
    MachineDeploymentV1Beta2.manifest(props.machineDeployment),
  ];
}
