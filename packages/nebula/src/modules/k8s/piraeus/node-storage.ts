/**
 * Typed Crossplane adapter from AWS node disks to Piraeus storage pools.
 *
 * The XCR is the declarative API. A purpose-built Go Composition Function
 * observes Linux Nodes, creates one durable encrypted EBS pool slot per
 * availability zone, attaches the slot to the selected node, and configures a
 * Piraeus LVM-thin pool using the volume's stable NVMe by-id path.
 */
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct, syncWave } from "../../../core";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";

export interface PiraeusNodeStorageConfig {
  /** AWS region containing the Kubernetes nodes and EBS pool volumes */
  region: string;
  /** One durable pool slot is created in each availability zone */
  availabilityZones: readonly string[];
  /** Immutable Crossplane Function package reference */
  functionPackage: string;
  /** Name of the XR instance (defaults to "piraeus-node-storage") */
  name?: string;
  /** Workload-identity-authenticated provider-aws ProviderConfig */
  awsProviderConfigRef?: string;
  /** Labels selecting the Linux Nodes eligible to host storage pools */
  nodeSelector?: Readonly<Record<string, string>>;
  /** LINSTOR storage pool name exposed to StorageClasses */
  storagePoolName?: string;
  /** Capacity of each per-zone EBS pool disk in GiB (defaults to 200) */
  sizeGiB?: number;
  /** EBS volume type (defaults to gp3) */
  volumeType?: "gp3" | "gp2" | "io1" | "io2" | "st1" | "sc1";
  /** Encrypt every EBS pool disk (defaults to true) */
  encrypted?: boolean;
  /** Create a final EBS snapshot before deleting a pool disk (defaults to true) */
  finalSnapshot?: boolean;
  /** Provisioned IOPS for gp3/io1/io2 */
  iops?: number;
  /** Provisioned throughput in MiB/s for gp3 */
  throughput?: number;
  /** AWS attachment hint; Nitro exposes a stable NVMe by-id path instead */
  deviceName?: string;
  /** Additional AWS tags applied to every pool disk */
  tags?: Readonly<Record<string, string>>;
  /** Crossplane core identity used to resolve Node requirements */
  crossplaneServiceAccount?: {
    name?: string;
    namespace?: string;
  };
}

export class PiraeusNodeStorage extends BaseConstruct<PiraeusNodeStorageConfig> {
  public readonly compositionFunction: ApiObject;
  public readonly nodeReaderRole: ApiObject;
  public readonly nodeReaderBinding: ApiObject;
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly instance: ApiObject;

  constructor(
    scope: Construct,
    id: string,
    config: PiraeusNodeStorageConfig,
  ) {
    super(scope, id, config);

    if (!this.config.region) {
      throw new Error("PiraeusNodeStorage: region must not be empty");
    }
    if (this.config.availabilityZones.length === 0) {
      throw new Error(
        "PiraeusNodeStorage: availabilityZones must not be empty",
      );
    }
    for (const zone of new Set(this.config.availabilityZones)) {
      if (!zone.startsWith(this.config.region)) {
        throw new Error(
          `PiraeusNodeStorage: availability zone "${zone}" is not in region "${this.config.region}"`,
        );
      }
    }
    if (
      new Set(this.config.availabilityZones).size !==
      this.config.availabilityZones.length
    ) {
      throw new Error(
        "PiraeusNodeStorage: availabilityZones must not contain duplicates",
      );
    }
    if (!this.config.functionPackage) {
      throw new Error("PiraeusNodeStorage: functionPackage must not be empty");
    }

    const sizeGiB = this.config.sizeGiB ?? 200;
    if (!Number.isSafeInteger(sizeGiB) || sizeGiB < 1) {
      throw new Error(
        "PiraeusNodeStorage: sizeGiB must be a positive integer",
      );
    }
    for (const [field, value] of [
      ["iops", this.config.iops],
      ["throughput", this.config.throughput],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1)
      ) {
        throw new Error(
          `PiraeusNodeStorage: ${field} must be a positive integer`,
        );
      }
    }

    const functionName = "function-piraeus-node-storage";
    const xrName = this.config.name ?? "piraeus-node-storage";
    const serviceAccountName =
      this.config.crossplaneServiceAccount?.name ?? "crossplane";
    const serviceAccountNamespace =
      this.config.crossplaneServiceAccount?.namespace ?? "crossplane-system";

    this.compositionFunction = new ApiObject(this, "function", {
      apiVersion: "pkg.crossplane.io/v1",
      kind: "Function",
      metadata: { name: functionName, annotations: syncWave(-12) },
      spec: { package: this.config.functionPackage },
    });

    // Crossplane core resolves the function's Node requirements. The function
    // runtime itself has no Kubernetes credentials or direct API access.
    this.nodeReaderRole = new ApiObject(this, "node-reader", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "crossplane-piraeus-node-storage-reader" },
      rules: [
        {
          apiGroups: [""],
          resources: ["nodes"],
          verbs: ["get", "list", "watch"],
        },
      ],
    });

    this.nodeReaderBinding = new ApiObject(this, "node-reader-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "crossplane-piraeus-node-storage-reader" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "crossplane-piraeus-node-storage-reader",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccountName,
          namespace: serviceAccountNamespace,
        },
      ],
    });

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xpiraeusnodestorages.nebula.io",
        annotations: syncWave(-10),
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XPiraeusNodeStorage",
          plural: "xpiraeusnodestorages",
        },
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
                      "region",
                      "availabilityZones",
                      "awsProviderConfigRef",
                      "storagePoolName",
                      "volume",
                    ],
                    properties: {
                      region: { type: "string", minLength: 1 },
                      availabilityZones: {
                        type: "array",
                        minItems: 1,
                        "x-kubernetes-list-type": "set",
                        items: { type: "string", minLength: 1 },
                      },
                      awsProviderConfigRef: {
                        type: "string",
                        minLength: 1,
                      },
                      nodeSelector: {
                        type: "object",
                        additionalProperties: { type: "string" },
                      },
                      storagePoolName: { type: "string", minLength: 3 },
                      volume: {
                        type: "object",
                        required: [
                          "sizeGiB",
                          "type",
                          "encrypted",
                          "finalSnapshot",
                          "deviceName",
                        ],
                        properties: {
                          sizeGiB: {
                            type: "integer",
                            format: "int64",
                            minimum: 1,
                          },
                          type: {
                            type: "string",
                            enum: [
                              "gp3",
                              "gp2",
                              "io1",
                              "io2",
                              "st1",
                              "sc1",
                            ],
                          },
                          encrypted: { type: "boolean" },
                          finalSnapshot: { type: "boolean" },
                          iops: {
                            type: "integer",
                            format: "int64",
                            minimum: 1,
                          },
                          throughput: {
                            type: "integer",
                            format: "int64",
                            minimum: 1,
                          },
                          deviceName: {
                            type: "string",
                            pattern: "^/dev/[^/]+$",
                          },
                          tags: {
                            type: "object",
                            additionalProperties: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: Object.fromEntries(
                      [
                        "zones",
                        "assignedNodes",
                        "readyVolumes",
                        "readyAttachments",
                        "readyStoragePools",
                      ].map((name) => [
                        name,
                        { type: "integer", format: "int32", minimum: 0 },
                      ]),
                    ),
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
        name: "piraeus-node-storage",
        annotations: syncWave(-5),
        labels: {
          "crossplane.io/xrd": "xpiraeusnodestorages.nebula.io",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XPiraeusNodeStorage",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "compose-piraeus-node-storage",
            functionRef: { name: functionName },
          },
        ],
      },
    });

    this.instance = new ApiObject(this, "instance", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XPiraeusNodeStorage",
      metadata: { name: xrName, annotations: syncWave(0) },
      spec: {
        region: this.config.region,
        availabilityZones: this.config.availabilityZones,
        awsProviderConfigRef: this.config.awsProviderConfigRef ?? "default",
        ...(this.config.nodeSelector
          ? { nodeSelector: this.config.nodeSelector }
          : {}),
        storagePoolName: this.config.storagePoolName ?? "PiraeusPool",
        volume: {
          sizeGiB,
          type: this.config.volumeType ?? "gp3",
          encrypted: this.config.encrypted ?? true,
          finalSnapshot: this.config.finalSnapshot ?? true,
          ...(this.config.iops !== undefined ? { iops: this.config.iops } : {}),
          ...(this.config.throughput !== undefined
            ? { throughput: this.config.throughput }
            : {}),
          deviceName: this.config.deviceName ?? "/dev/sdf",
          ...(this.config.tags ? { tags: this.config.tags } : {}),
        },
      },
    });
  }
}
