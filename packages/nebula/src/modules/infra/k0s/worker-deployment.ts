import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { createHash } from "node:crypto";
import { DEFAULT_PRESTART_COMMANDS, NODE_IP_DISCOVERY_COMMANDS, renderK0sWorkerArgs, withNodeIpArgs, type K0sInfraProvider, type K0sWorkerPool } from "./cluster";

export interface K0sWorkerDeploymentConfig<M> {
  name: string;
  clusterName: string;
  namespace?: string;
  k0sVersion: string;
  provider: K0sInfraProvider<M>;
  pool: K0sWorkerPool<M>;
  /** Preserve an installed host's hostname and local-volume affinity. */
  hostname?: string;
  dualStack?: boolean;
  /** Preserve an existing MachineDeployment's immutable selector. */
  selectorLabels?: Record<string, string>;
}

/** A workload-owned native CAPI worker deployment on an existing cluster. */
export class K0sWorkerDeployment<M> extends Construct {
  readonly deployment: ApiObject;
  constructor(scope: Construct, id: string, config: K0sWorkerDeploymentConfig<M>) {
    super(scope, id);
    const { name, clusterName, pool, provider } = config;
    const namespace = config.namespace ?? "default";
    if (pool.autoscaling) throw new Error("K0sWorkerDeployment requires a fixed replica count");
    if (config.hostname && (pool.replicas ?? 1) !== 1) throw new Error("a stable hostname requires exactly one worker");
    if (config.hostname && !/^[a-z0-9][a-z0-9.-]*$/.test(config.hostname)) throw new Error("invalid worker hostname");
    const infra = provider.emitMachineTemplate(this, "machine", { baseName: name, namespace, role: "worker", machine: pool.machine });
    const args = renderK0sWorkerArgs(pool);
    const bootstrap = {
      version: config.k0sVersion,
      args: config.dualStack ? withNodeIpArgs(args) : args,
      ...(config.hostname ? { useSystemHostname: true } : {}),
      preK0sCommands: [
        ...(config.hostname ? [`hostnamectl set-hostname ${config.hostname}`] : []),
        ...(provider.hostPreK0sCommands?.(pool.machine, "worker") ?? []),
        ...DEFAULT_PRESTART_COMMANDS,
        ...(config.dualStack ? NODE_IP_DISCOVERY_COMMANDS : []),
        ...(pool.extraPreStartCommands ?? []),
      ],
    };
    const hash = createHash("sha256").update(JSON.stringify(bootstrap)).digest("hex").slice(0, 12);
    const bootstrapName = `${name}-config-${hash}`;
    new ApiObject(this, "bootstrap", { apiVersion: "bootstrap.cluster.x-k8s.io/v1beta2", kind: "K0sWorkerConfigTemplate",
      metadata: { name: bootstrapName, namespace }, spec: { template: { spec: bootstrap } } });
    const labels = { "cluster.x-k8s.io/cluster-name": clusterName, ...config.selectorLabels };
    this.deployment = new ApiObject(this, "deployment", { apiVersion: "cluster.x-k8s.io/v1beta2", kind: "MachineDeployment",
      metadata: { name, namespace }, spec: {
        clusterName, replicas: pool.replicas ?? 1, selector: { matchLabels: labels },
        rollout: { strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } } },
        template: { metadata: { labels }, spec: {
          clusterName, version: config.k0sVersion.split("+")[0],
          deletion: { nodeDrainTimeoutSeconds: 300 },
          ...(pool.failureDomain ? { failureDomain: pool.failureDomain } : {}),
          bootstrap: { configRef: { apiGroup: "bootstrap.cluster.x-k8s.io", kind: "K0sWorkerConfigTemplate", name: bootstrapName } },
          infrastructureRef: { apiGroup: infra.apiVersion.split("/")[0], kind: infra.kind, name: infra.name },
        } },
      } });
  }
}
