/**
 * Eip-derived k0smotron machine inventory via Crossplane Composition.
 *
 * Bridges a Crossplane-created host to CAPI adoption WITHOUT any address in
 * git: observes an Eip managed resource on the local cluster and, once its
 * allocated address is reported, composes a k0smotron `PooledRemoteMachine` —
 * the SSH inventory entry a git-static `RemoteMachine{pool}` reserves to be
 * provisioned.
 *
 * Why the pool and not the RemoteMachine itself: CAPI's Machine controller
 * ADOPTS its infrastructure object with a controller ownerReference, and
 * Crossplane sets a controller ownerReference on everything it composes — the
 * two claims are mutually exclusive on one object. `PooledRemoteMachine` is
 * k0smotron's own indirection for exactly this: nothing adopts inventory (the
 * controller only reads it and writes status.reserved), so the composition can
 * own it outright while the git-static `RemoteMachine` stays free for CAPI.
 *
 * Use a POOL PER NODE (pool == node name) when hosts are pets with distinct
 * identities (data volumes, geo labels): a pool of one makes the reservation
 * deterministic, so an address can never cross-match onto the wrong Machine.
 *
 * Pure patch-and-transform: the observe step publishes the Eip's address onto
 * the XR status, and the inventory entry patches it back with a Required
 * policy — the PooledRemoteMachine is not composed at all until the address
 * exists, so the pool stays empty and the RemoteMachine waits unreserved.
 * readinessChecks None marks the entry ready on creation (it has no Ready
 * condition of its own for function-auto-ready to find).
 *
 * Split like {@link EipDnsRecordSetup}:
 * - `RemoteWorkerSetup` — the shared XRD + Composition (install once)
 * - `RemoteWorker` — an XR instance (one per adopted host)
 *
 * Prerequisites: provider-kubernetes (ProviderConfig + RBAC to read
 * eips.ec2.aws.upbound.io), function-patch-and-transform, function-auto-ready,
 * and Crossplane RBAC to manage
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

export interface RemoteWorkerConfig {
  /** metadata.name of the Eip managed resource to observe (cluster-scoped). */
  eipName: string;
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

/** The shared XRD + Composition. Install once (e.g. alongside the cluster). */
export class RemoteWorkerSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xremoteworkers.nebula.io",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10" },
      },
      spec: {
        group: "nebula.io",
        names: { kind: "XRemoteWorker", plural: "xremoteworkers" },
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
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    this.composition = new Composition(this, "composition", {
      metadata: {
        name: "remote-worker",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-5" },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XRemoteWorker",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "patch-and-transform",
            functionRef: { name: "function-patch-and-transform" },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                {
                  name: "eip",
                  base: {
                    apiVersion: "kubernetes.crossplane.io/v1alpha2",
                    kind: "Object",
                    spec: {
                      managementPolicies: ["Observe"],
                      forProvider: {
                        manifest: {
                          apiVersion: "ec2.aws.upbound.io/v1beta1",
                          kind: "EIP",
                          metadata: { name: "placeholder" },
                        },
                      },
                    },
                  },
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.eipName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.kubeProviderConfigName",
                      toFieldPath: "spec.providerConfigRef.name",
                    },
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.publicIp",
                      toFieldPath: "status.publicIp",
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
              ],
            },
          },
          {
            step: "auto-ready",
            functionRef: { name: "function-auto-ready" },
          },
        ],
      },
    });
  }
}

/** An XR instance publishing one host into one pool. Requires {@link RemoteWorkerSetup}. */
export class RemoteWorker extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: RemoteWorkerConfig) {
    super(scope, id);

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XRemoteWorker",
      metadata: { name: id },
      spec: {
        eipName: config.eipName,
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
