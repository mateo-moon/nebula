/**
 * Typed credential bridge for LINSTOR's native AWS EBS integration.
 *
 * provider-aws authenticates through workload identity. The XCR creates only a
 * least-privilege IAM user/access key and publishes the resulting connection
 * Secret for LINSTOR. Storage lifecycle remains owned by LINSTOR/Piraeus.
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
  /** Immutable Crossplane Function package reference */
  functionPackage: string;
  /** Dedicated IAM user name */
  iamUserName: string;
  /** Name of the XR instance (defaults to "piraeus-ebs-credentials") */
  name?: string;
  /** Workload-identity-authenticated provider-aws ProviderConfig */
  awsProviderConfigRef?: string;
  /** Names of image pull Secrets (in the Crossplane install namespace) for the Function package */
  packagePullSecrets?: readonly string[];
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

export class PiraeusEbsCredentials extends BaseConstruct<PiraeusEbsCredentialsConfig> {
  public readonly compositionFunction: ApiObject;
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
    if (!this.config.functionPackage) {
      throw new Error(
        "PiraeusEbsCredentials: functionPackage must not be empty",
      );
    }

    const functionName = "function-piraeus-ebs-credentials";
    const xrName = this.config.name ?? "piraeus-ebs-credentials";
    const credentialSecretName =
      this.config.credentialSecret?.name ?? "linstor-ebs-aws-credentials";
    const credentialSecretNamespace =
      this.config.credentialSecret?.namespace ?? "crossplane-system";

    this.compositionFunction = new ApiObject(this, "function", {
      apiVersion: "pkg.crossplane.io/v1",
      kind: "Function",
      metadata: { name: functionName, annotations: syncWave(-12) },
      spec: {
        package: this.config.functionPackage,
        ...(this.config.packagePullSecrets?.length
          ? {
              packagePullSecrets: this.config.packagePullSecrets.map(
                (name) => ({ name }),
              ),
            }
          : {}),
      },
    });

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
