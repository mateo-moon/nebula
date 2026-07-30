/**
 * SshK0sProvider — the machine-less infrastructure adapter for
 * {@link K0sCluster}: every node is an externally-provisioned host (any cloud,
 * bare metal) joined over SSH via k0smotron `RemoteMachine` + a {@link Worker}
 * adoption unit. The provider's only emission is k0smotron's `RemoteCluster` —
 * the CAPI infra-cluster stand-in whose single concern is the control-plane
 * endpoint, which the hosted `K0smotronControlPlane` publishes itself.
 *
 * This is what unifies node provisioning: no machine templates, no
 * cloud-provider machine pools — the cluster construct stands up the CP and
 * adoption plumbing, and nodes arrive exclusively through Worker units.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import type {
  CapiInfraRef,
  EmitInfraClusterCtx,
  EmitMachineTemplateCtx,
  K0sInfraProvider,
} from "./cluster";

export class SshK0sProvider implements K0sInfraProvider<never> {
  readonly infraClusterApiGroup = "infrastructure.cluster.x-k8s.io";
  readonly infraClusterKind = "RemoteCluster";

  emitInfraCluster(scope: Construct, ctx: EmitInfraClusterCtx): void {
    if (!ctx.hostedControlPlane) {
      // A standalone CP needs CP machines, which this provider cannot emit.
      throw new Error(
        "SshK0sProvider requires a hosted control plane (K0smotronControlPlane)",
      );
    }
    new ApiObject(scope, "remote-cluster", {
      apiVersion: "infrastructure.cluster.x-k8s.io/v1beta1",
      kind: "RemoteCluster",
      metadata: { name: ctx.clusterName, namespace: ctx.namespace },
      // k0smotron copies the hosted CP's endpoint onto the CAPI Cluster; the
      // RemoteCluster itself carries no configuration.
      spec: {},
    });
  }

  emitMachineTemplate(
    _scope: Construct,
    _id: string,
    _ctx: EmitMachineTemplateCtx<never>,
  ): CapiInfraRef {
    throw new Error(
      "SshK0sProvider has no machine templates — nodes join via Worker units (workerPools must be empty)",
    );
  }
}
