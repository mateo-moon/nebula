/**
 * Crossplane-instance k0s worker: the ONE node unit for every cluster node.
 *
 * A node is a git-declared identity (Instance shape, Eip, data EBSVolume) plus
 * runtime bindings this composition derives with zero addresses or ids in git:
 *
 * - observes the node's `EIP` and `Instance` managed resources (and the data
 *   `EBSVolume` when one is declared) on the local cluster;
 * - composes the k0smotron `PooledRemoteMachine` — the SSH inventory entry the
 *   git-static `RemoteMachine{pool}` reserves for CAPI adoption;
 * - composes the `EIPAssociation` and `VolumeAttachment` follower MRs with
 *   INSTANCE-ID-DERIVED NAMES. Upjet refuses updates that require replacement
 *   (instance_id/allocation_id/volume_id all do), so a name-stable follower
 *   wedges forever when the instance is replaced (spot reclaim, subnet moves).
 *   Deriving the name from the observed instance id turns replacement into
 *   create-new + garbage-collect-old — the wedge class dies by construction.
 *
 * Why the pool and not the RemoteMachine itself: CAPI's Machine controller
 * ADOPTS its infrastructure object with a controller ownerReference, and
 * Crossplane sets a controller ownerReference on everything it composes — the
 * two claims are mutually exclusive on one object. `PooledRemoteMachine` is
 * k0smotron's own indirection for exactly this: nothing adopts inventory (the
 * controller only reads it and writes status.reserved), so the composition can
 * own it outright while the git-static `RemoteMachine` stays free for CAPI.
 * Use a POOL PER NODE (pool == node name): hosts are pets with distinct
 * identities, and a pool of one makes the reservation deterministic.
 *
 * Fail-closed patching (the DualStackSubnet lesson): every value derived from
 * an observation gates its consumer with a Required policy, and nothing is
 * composed until the value exists — an empty pool or a missing follower, never
 * a wrong address or a "placeholder" name.
 *
 * Split like {@link EipDnsRecordSetup}:
 * - `WorkerSetup` — the shared XRD + Composition (install once)
 * - `Worker` — an XR instance (one per node)
 *
 * Prerequisites: provider-kubernetes (ProviderConfig + RBAC to read
 * eips/instances/ebsvolumes.ec2.aws.upbound.io), function-patch-and-transform,
 * function-auto-ready, and Crossplane RBAC to manage
 * pooledremotemachines.infrastructure.cluster.x-k8s.io.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { ARGOCD_SYNC_WAVE_ANNOTATION } from "../../../core";

export interface WorkerConfig {
  /** metadata.name of the Eip managed resource to observe (cluster-scoped). */
  eipName: string;
  /** metadata.name of the Instance managed resource to observe. */
  instanceName: string;
  /** AWS region for the composed follower MRs (EIPAssociation/VolumeAttachment). */
  region: string;
  /** metadata.name of the data EBSVolume MR. Omit for nodes without one. */
  dataVolumeName?: string;
  /** Device name for the data-volume attachment (default "/dev/sdf"). */
  deviceName?: string;
  /** Pool name the git-side RemoteMachine reserves from (default: the XR id). */
  pool?: string;
  /** Namespace for the PooledRemoteMachine (default "default"). */
  namespace?: string;
  /** Secret holding the SSH private key under key "value". */
  sshSecretName: string;
  /** SSH user (default "ubuntu"; Ubuntu AMIs disable root logins). */
  sshUser?: string;
  /** SSH port (default 22). */
  sshPort?: number;
  /** Run provisioning commands under sudo (default true for non-root users). */
  useSudo?: boolean;
  /** provider-kubernetes ProviderConfig name (default "kubernetes-provider-config"). */
  kubeProviderConfigName?: string;
}

/** Observe-Object base for one local managed resource by name. */
const observeBase = (kind: string) => ({
  apiVersion: "kubernetes.crossplane.io/v1alpha2",
  kind: "Object",
  spec: {
    managementPolicies: ["Observe"],
    forProvider: {
      manifest: {
        apiVersion: "ec2.aws.upbound.io/v1beta1",
        kind,
        metadata: { name: "placeholder" },
      },
    },
  },
});

const providerConfigPatch = {
  type: "FromCompositeFieldPath",
  fromFieldPath: "spec.kubeProviderConfigName",
  toFieldPath: "spec.providerConfigRef.name",
};

/** The shared XRD + Composition. Install once (e.g. alongside the cluster). */
export class WorkerSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Crossplane composes the PooledRemoteMachine DIRECTLY (no provider), so
    // its own service account needs RBAC on the kind. The rbac-manager
    // aggregates any ClusterRole carrying this label into crossplane's role —
    // without it every compose attempt is denied at apply time. (The AWS MRs
    // need no grant: the rbac-manager covers provider CRDs automatically.)
    new ApiObject(this, "crossplane-rbac", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: {
        name: "crossplane:aggregate:worker",
        labels: { "rbac.crossplane.io/aggregate-to-crossplane": "true" },
      },
      rules: [
        {
          apiGroups: ["infrastructure.cluster.x-k8s.io"],
          resources: ["pooledremotemachines", "pooledremotemachines/status"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
      ],
    });

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xworkers.nebula.io",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10" },
      },
      spec: {
        group: "nebula.io",
        names: { kind: "XWorker", plural: "xworkers" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    required: [
                      "eipName",
                      "instanceName",
                      "region",
                      "deviceName",
                      "pool",
                      "namespace",
                      "sshSecretName",
                      "sshUser",
                      "sshPort",
                      "useSudo",
                      "kubeProviderConfigName",
                    ],
                    properties: {
                      eipName: {
                        type: "string",
                        description: "Eip managed-resource name to observe",
                      },
                      instanceName: {
                        type: "string",
                        description: "Instance managed-resource name to observe",
                      },
                      region: {
                        type: "string",
                        description: "AWS region for composed follower MRs",
                      },
                      dataVolumeName: {
                        type: "string",
                        description:
                          "Data EBSVolume MR name (omit: no attachment composed)",
                      },
                      deviceName: {
                        type: "string",
                        description: "Data-volume attachment device name",
                      },
                      pool: {
                        type: "string",
                        description:
                          "k0smotron pool the RemoteMachine reserves from",
                      },
                      namespace: {
                        type: "string",
                        description: "PooledRemoteMachine namespace",
                      },
                      sshSecretName: {
                        type: "string",
                        description:
                          'Secret with the SSH private key under key "value"',
                      },
                      sshUser: { type: "string", description: "SSH user" },
                      sshPort: { type: "integer", description: "SSH port" },
                      useSudo: {
                        type: "boolean",
                        description: "Provision with sudo",
                      },
                      kubeProviderConfigName: {
                        type: "string",
                        description: "provider-kubernetes ProviderConfig name",
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      publicIp: {
                        type: "string",
                        description: "Address observed from the Eip",
                      },
                      allocationId: {
                        type: "string",
                        description: "Allocation id observed from the Eip",
                      },
                      instanceId: {
                        type: "string",
                        description: "Id observed from the Instance",
                      },
                      volumeId: {
                        type: "string",
                        description: "Id observed from the data EBSVolume",
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    // Two variants: a Required-skipped composed resource keeps the XR in
    // Ready=False/Creating forever (observed live on every data-less node),
    // so nodes without a data volume SELECT a composition without the volume
    // pair instead of skipping it at patch time.
    const baseResources: object[] = [
                {
                  name: "eip",
                  base: observeBase("EIP"),
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.eipName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    providerConfigPatch,
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.publicIp",
                      toFieldPath: "status.publicIp",
                    },
                    // For a vpc-domain EIP the MR id IS the allocation id.
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.id",
                      toFieldPath: "status.allocationId",
                    },
                  ],
                },
                {
                  name: "instance",
                  base: observeBase("Instance"),
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.instanceName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    providerConfigPatch,
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.id",
                      toFieldPath: "status.instanceId",
                    },
                  ],
                },
                {
                  name: "pooled-machine",
                  base: {
                    // v1beta2 = the storage version. Composing the non-storage
                    // version makes every read-back a converted object that
                    // never matches what was applied (permanent drift).
                    apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
                    kind: "PooledRemoteMachine",
                    metadata: { name: "placeholder", namespace: "default" },
                    spec: {
                      pool: "placeholder",
                      machine: {
                        address: "placeholder",
                        port: 22,
                        user: "ubuntu",
                        useSudo: true,
                        sshKeyRef: { name: "placeholder" },
                      },
                    },
                  },
                  // No Ready condition on inventory — existing is ready.
                  readinessChecks: [{ type: "None" }],
                  patches: [
                    // Required: the entry is not composed at all until the
                    // observed address lands on the XR status — an empty pool,
                    // never a wrong address.
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.publicIp",
                      toFieldPath: "spec.machine.address",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.pool",
                      toFieldPath: "metadata.name",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.namespace",
                      toFieldPath: "metadata.namespace",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.pool",
                      toFieldPath: "spec.pool",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.sshPort",
                      toFieldPath: "spec.machine.port",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.sshUser",
                      toFieldPath: "spec.machine.user",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.useSudo",
                      toFieldPath: "spec.machine.useSudo",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.sshSecretName",
                      toFieldPath: "spec.machine.sshKeyRef.name",
                    },
                  ],
                },
                {
                  name: "eip-association",
                  base: {
                    apiVersion: "ec2.aws.upbound.io/v1beta1",
                    kind: "EIPAssociation",
                    metadata: { name: "placeholder" },
                    spec: {
                      // No LateInitialize: it captures the observed publicIp
                      // (association) / device state into spec, and a recreate
                      // after severance then sends publicIp AND allocationId -
                      // "may specify public IP or allocation id, but not both"
                      // (observed live). Same guard the git-era followers had.
                      // No Update either: instance_id/allocation_id changes all
                      // require replacement, which upjet refuses — the follower
                      // model replaces via the instance-id-derived NAME (new MR,
                      // GC old), so Update can only ever wedge (observed live:
                      // 7 followers Synced=False after instance churn).
                      managementPolicies: ["Observe", "Create", "Delete"],
                      forProvider: {
                        region: "placeholder",
                        allowReassociation: true,
                      },
                    },
                  },
                  patches: [
                    // Name from the observed instance id: replacement composes
                    // a fresh association and garbage-collects the stale one —
                    // never an in-place instance_id update for upjet to refuse.
                    {
                      type: "CombineFromComposite",
                      combine: {
                        variables: [
                          { fromFieldPath: "metadata.name" },
                          { fromFieldPath: "status.instanceId" },
                        ],
                        strategy: "string",
                        string: { fmt: "%s-%s" },
                      },
                      toFieldPath: "metadata.name",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.region",
                      toFieldPath: "spec.forProvider.region",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.allocationId",
                      toFieldPath: "spec.forProvider.allocationId",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.instanceId",
                      toFieldPath: "spec.forProvider.instanceId",
                      policy: { fromFieldPath: "Required" },
                    },
                  ],
                },
    ];
    const volumeResources: object[] = [
                {
                  name: "data-volume",
                  base: observeBase("EBSVolume"),
                  patches: [
                    // Required gates the whole Object: a node without a data
                    // volume composes no observer (and so no attachment).
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.dataVolumeName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                      policy: { fromFieldPath: "Required" },
                    },
                    providerConfigPatch,
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.id",
                      toFieldPath: "status.volumeId",
                    },
                  ],
                },
                {
                  name: "volume-attachment",
                  base: {
                    apiVersion: "ec2.aws.upbound.io/v1beta1",
                    kind: "VolumeAttachment",
                    metadata: { name: "placeholder" },
                    spec: {
                      // No LateInitialize: it captures the observed publicIp
                      // (association) / device state into spec, and a recreate
                      // after severance then sends publicIp AND allocationId -
                      // "may specify public IP or allocation id, but not both"
                      // (observed live). Same guard the git-era followers had.
                      managementPolicies: ["Observe", "Create", "Update", "Delete"],
                      forProvider: {
                        region: "placeholder",
                        deviceName: "placeholder",
                      },
                    },
                  },
                  patches: [
                    {
                      type: "CombineFromComposite",
                      combine: {
                        variables: [
                          { fromFieldPath: "metadata.name" },
                          { fromFieldPath: "status.instanceId" },
                        ],
                        strategy: "string",
                        string: { fmt: "%s-data-%s" },
                      },
                      toFieldPath: "metadata.name",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.region",
                      toFieldPath: "spec.forProvider.region",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.deviceName",
                      toFieldPath: "spec.forProvider.deviceName",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.volumeId",
                      toFieldPath: "spec.forProvider.volumeId",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.instanceId",
                      toFieldPath: "spec.forProvider.instanceId",
                      policy: { fromFieldPath: "Required" },
                    },
                  ],
                },
    ];
    const mkComposition = (id: string, name: string, resources: object[]) =>
      new Composition(this, id, {
        metadata: {
          name,
          annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-5" },
        },
        spec: {
          compositeTypeRef: {
            apiVersion: "nebula.io/v1alpha1",
            kind: "XWorker",
          },
          mode: CompositionSpecMode.PIPELINE,
          pipeline: [
            {
              step: "patch-and-transform",
              functionRef: { name: "function-patch-and-transform" },
              input: {
                apiVersion: "pt.fn.crossplane.io/v1beta1",
                kind: "Resources",
                resources,
              },
            },
            {
              step: "auto-ready",
              functionRef: { name: "function-auto-ready" },
            },
          ],
        },
      });
    this.composition = mkComposition("composition", "worker", [
      ...baseResources,
      ...volumeResources,
    ]);
    mkComposition("composition-basic", "worker-basic", baseResources);
  }
}

/** An XR instance binding one node. Requires {@link WorkerSetup}. */
export class Worker extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: WorkerConfig) {
    super(scope, id);

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XWorker",
      metadata: { name: id },
      spec: {
        // v2 XRD: machinery fields nest under spec.crossplane — a top-level
        // compositionRef is silently pruned by the structural schema.
        crossplane: {
          compositionRef: {
            name: config.dataVolumeName ? "worker" : "worker-basic",
          },
        },
        eipName: config.eipName,
        instanceName: config.instanceName,
        region: config.region,
        ...(config.dataVolumeName
          ? { dataVolumeName: config.dataVolumeName }
          : {}),
        deviceName: config.deviceName ?? "/dev/sdf",
        pool: config.pool ?? id,
        namespace: config.namespace ?? "default",
        sshSecretName: config.sshSecretName,
        sshUser: config.sshUser ?? "ubuntu",
        sshPort: config.sshPort ?? 22,
        useSudo: config.useSudo ?? true,
        kubeProviderConfigName:
          config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}
