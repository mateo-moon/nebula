/**
 * Credential bridge for LINSTOR's native AWS EBS integration.
 *
 * provider-aws authenticates through workload identity. The XCR creates only a
 * least-privilege IAM user/access key and publishes the resulting connection
 * Secret for LINSTOR. Storage lifecycle remains owned by LINSTOR/Piraeus.
 * Composition runs on the pre-installed patch-and-transform function; no
 * custom function image is involved.
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

export interface PiraeusEbsCredentialsConfig {
  /** AWS region in which LINSTOR may manage EBS volumes */
  region: string;
  /** Dedicated IAM user name */
  iamUserName: string;
  /** Name of the XR instance (defaults to "piraeus-ebs-credentials") */
  name?: string;
  /** Workload-identity-authenticated provider-aws ProviderConfig */
  awsProviderConfigRef?: string;
  /** Installed patch-and-transform Function (default "function-patch-and-transform", installed by the Crossplane module) */
  functionRef?: string;
  /** Secret written by the provider-aws AccessKey resource */
  credentialSecret?: {
    /** Defaults to "linstor-ebs-aws-credentials" */
    name?: string;
    /** Defaults to "crossplane-system" */
    namespace?: string;
  };
  /** Additional tags applied to the IAM user and policy */
  tags?: Readonly<Record<string, string>>;
}

const EBS_ACTIONS = [
  "ec2:AttachVolume",
  "ec2:CreateSnapshot",
  "ec2:CreateTags",
  "ec2:CreateVolume",
  "ec2:DeleteSnapshot",
  "ec2:DeleteTags",
  "ec2:DeleteVolume",
  "ec2:DescribeAvailabilityZones",
  "ec2:DescribeInstances",
  "ec2:DescribeSnapshots",
  "ec2:DescribeVolumes",
  "ec2:DescribeVolumesModifications",
  "ec2:DetachVolume",
  "ec2:ModifyVolume",
] as const;

export class PiraeusEbsCredentials extends BaseConstruct<PiraeusEbsCredentialsConfig> {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly instance: ApiObject;

  constructor(
    scope: Construct,
    id: string,
    config: PiraeusEbsCredentialsConfig,
  ) {
    super(scope, id, config);

    if (!this.config.region) {
      throw new Error("PiraeusEbsCredentials: region must not be empty");
    }
    if (!this.config.iamUserName) {
      throw new Error("PiraeusEbsCredentials: iamUserName must not be empty");
    }

    const functionName =
      this.config.functionRef ?? "function-patch-and-transform";
    const xrName = this.config.name ?? "piraeus-ebs-credentials";
    const credentialSecretName =
      this.config.credentialSecret?.name ?? "linstor-ebs-aws-credentials";
    const credentialSecretNamespace =
      this.config.credentialSecret?.namespace ?? "crossplane-system";
    const resourceTags = {
      ManagedBy: "crossplane",
      Purpose: "piraeus-linstor-ebs",
      ...this.config.tags,
    };
    // %s is replaced with spec.region by a string Format patch.
    const policyDocumentFmt = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "LinstorEbs",
          Effect: "Allow",
          Action: EBS_ACTIONS,
          Resource: "*",
          Condition: { StringEquals: { "aws:RequestedRegion": "%s" } },
        },
      ],
    });
    const providerConfigRefPatch = {
      fromFieldPath: "spec.awsProviderConfigRef",
      toFieldPath: "spec.providerConfigRef.name",
    };

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xpiraeusebscredentials.nebula.io",
        annotations: syncWave(-10),
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XPiraeusEbsCredentials",
          plural: "xpiraeusebscredentials",
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
                      "iamUserName",
                      "awsProviderConfigRef",
                      "credentialSecretName",
                      "credentialSecretNamespace",
                    ],
                    properties: {
                      region: { type: "string", minLength: 1 },
                      iamUserName: { type: "string", minLength: 1 },
                      awsProviderConfigRef: {
                        type: "string",
                        minLength: 1,
                      },
                      credentialSecretName: {
                        type: "string",
                        minLength: 1,
                      },
                      credentialSecretNamespace: {
                        type: "string",
                        minLength: 1,
                      },
                      tags: {
                        type: "object",
                        additionalProperties: { type: "string" },
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      credentialSecretRef: {
                        type: "object",
                        required: ["name", "namespace"],
                        properties: {
                          name: { type: "string" },
                          namespace: { type: "string" },
                        },
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
        name: "piraeus-ebs-credentials",
        annotations: syncWave(-5),
        labels: {
          "crossplane.io/xrd": "xpiraeusebscredentials.nebula.io",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XPiraeusEbsCredentials",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "provision-piraeus-ebs-credentials",
            functionRef: { name: functionName },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                {
                  name: "iam-user",
                  base: {
                    apiVersion: "iam.aws.upbound.io/v1beta1",
                    kind: "User",
                    spec: {
                      deletionPolicy: "Delete",
                      forProvider: {
                        forceDestroy: true,
                        path: "/piraeus/",
                        tags: resourceTags,
                      },
                      providerConfigRef: { name: "default" },
                    },
                  },
                  patches: [
                    {
                      fromFieldPath: "spec.iamUserName",
                      toFieldPath:
                        'metadata.annotations[crossplane.io/external-name]',
                    },
                    providerConfigRefPatch,
                  ],
                },
                {
                  name: "iam-policy",
                  base: {
                    apiVersion: "iam.aws.upbound.io/v1beta1",
                    kind: "Policy",
                    spec: {
                      deletionPolicy: "Delete",
                      forProvider: {
                        path: "/piraeus/",
                        policy: "",
                        tags: resourceTags,
                      },
                      providerConfigRef: { name: "default" },
                    },
                  },
                  patches: [
                    {
                      fromFieldPath: "spec.iamUserName",
                      toFieldPath:
                        'metadata.annotations[crossplane.io/external-name]',
                      transforms: [
                        {
                          type: "string",
                          string: { type: "Format", fmt: "%s-policy" },
                        },
                      ],
                    },
                    {
                      fromFieldPath: "spec.region",
                      toFieldPath: "spec.forProvider.policy",
                      transforms: [
                        {
                          type: "string",
                          string: { type: "Format", fmt: policyDocumentFmt },
                        },
                      ],
                    },
                    providerConfigRefPatch,
                  ],
                },
                {
                  name: "iam-policy-attachment",
                  base: {
                    apiVersion: "iam.aws.upbound.io/v1beta1",
                    kind: "UserPolicyAttachment",
                    spec: {
                      deletionPolicy: "Delete",
                      forProvider: {
                        policyArnSelector: { matchControllerRef: true },
                        userSelector: { matchControllerRef: true },
                      },
                      providerConfigRef: { name: "default" },
                    },
                  },
                  patches: [providerConfigRefPatch],
                },
                {
                  name: "iam-access-key",
                  base: {
                    apiVersion: "iam.aws.upbound.io/v1beta1",
                    kind: "AccessKey",
                    spec: {
                      deletionPolicy: "Delete",
                      forProvider: {
                        status: "Active",
                        userSelector: { matchControllerRef: true },
                      },
                      providerConfigRef: { name: "default" },
                      writeConnectionSecretToRef: {
                        name: credentialSecretName,
                        namespace: credentialSecretNamespace,
                      },
                    },
                  },
                  patches: [
                    {
                      fromFieldPath: "spec.credentialSecretName",
                      toFieldPath: "spec.writeConnectionSecretToRef.name",
                    },
                    {
                      fromFieldPath: "spec.credentialSecretNamespace",
                      toFieldPath: "spec.writeConnectionSecretToRef.namespace",
                    },
                    providerConfigRefPatch,
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath: "spec.writeConnectionSecretToRef.name",
                      toFieldPath: "status.credentialSecretRef.name",
                    },
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath: "spec.writeConnectionSecretToRef.namespace",
                      toFieldPath: "status.credentialSecretRef.namespace",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    this.instance = new ApiObject(this, "instance", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XPiraeusEbsCredentials",
      metadata: { name: xrName, annotations: syncWave(0) },
      spec: {
        region: this.config.region,
        iamUserName: this.config.iamUserName,
        awsProviderConfigRef: this.config.awsProviderConfigRef ?? "default",
        credentialSecretName,
        credentialSecretNamespace,
        ...(this.config.tags ? { tags: this.config.tags } : {}),
      },
    });
  }
}
