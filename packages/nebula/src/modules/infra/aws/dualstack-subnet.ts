/**
 * Vpc-derived dual-stack Subnet via Crossplane Composition.
 *
 * A subnet's IPv6 /64 must be carved from the VPC's Amazon-ASSIGNED /56 — a
 * value that exists only at runtime, which is why a git-literal Subnet cannot
 * be dual-stack without hardcoding an allocation AWS made. This composition
 * observes the Vpc managed resource and derives the subnet CIDR with a string
 * transform (…::/56 → …::/64), the same observe-and-derive pattern as
 * EipDnsRecord and RemoteWorker.
 *
 * The subnet is composed (not git-literal), so converting an existing region
 * REPLACES the subnet — and with it the instances in it. For hosts under
 * RemoteMachine adoption that is routine: the machinery re-provisions
 * replacements automatically.
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

export interface DualStackSubnetConfig {
  /** metadata.name of the Vpc managed resource to observe. */
  vpcMrName: string;
  region: string;
  availabilityZone: string;
  /** IPv4 CIDR for the subnet (a git constant, e.g. "10.6.0.0/20"). */
  cidrBlock: string;
  mapPublicIpOnLaunch?: boolean;
  tags?: Record<string, string>;
  /** provider-kubernetes ProviderConfig name (default "kubernetes-provider-config"). */
  kubeProviderConfigName?: string;
}

/** The shared XRD + Composition. Install once. */
export class DualStackSubnetSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xdualstacksubnets.nebula.io",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10" },
      },
      spec: {
        group: "nebula.io",
        names: { kind: "XDualStackSubnet", plural: "xdualstacksubnets" },
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
                      "vpcMrName",
                      "region",
                      "availabilityZone",
                      "cidrBlock",
                      "mapPublicIpOnLaunch",
                      "kubeProviderConfigName",
                    ],
                    properties: {
                      vpcMrName: { type: "string" },
                      region: { type: "string" },
                      availabilityZone: { type: "string" },
                      cidrBlock: { type: "string" },
                      mapPublicIpOnLaunch: { type: "boolean" },
                      tags: {
                        type: "object",
                        additionalProperties: { type: "string" },
                      },
                      kubeProviderConfigName: { type: "string" },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      subnetIpv6Cidr: { type: "string" },
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
        name: "dualstack-subnet",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-5" },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XDualStackSubnet",
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
                  name: "vpc",
                  base: {
                    apiVersion: "kubernetes.crossplane.io/v1alpha2",
                    kind: "Object",
                    spec: {
                      managementPolicies: ["Observe"],
                      forProvider: {
                        manifest: {
                          apiVersion: "ec2.aws.upbound.io/v1beta1",
                          kind: "VPC",
                          metadata: { name: "placeholder" },
                        },
                      },
                    },
                  },
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.vpcMrName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.kubeProviderConfigName",
                      toFieldPath: "spec.providerConfigRef.name",
                    },
                    // Transform HERE, not on the subnet patch: during v6
                    // association the VPC reports ipv6CidrBlock as an EMPTY
                    // string, which satisfies a Required policy (the field
                    // exists) - observed live: "" persisted to XR status, the
                    // subnet-side regexp fatally erroring on it, and the fatal
                    // aborting the very patch that would refresh the status.
                    // With the transform on the write side an empty value
                    // fails BEFORE anything persists; the pipeline retries
                    // until the VPC reports a real /56.
                    {
                      type: "ToCompositeFieldPath",
                      fromFieldPath:
                        "status.atProvider.manifest.status.atProvider.ipv6CidrBlock",
                      toFieldPath: "status.subnetIpv6Cidr",
                      transforms: [
                        {
                          type: "string",
                          string: {
                            type: "Regexp",
                            regexp: { match: "^(.+)/56$", group: 1 },
                          },
                        },
                        { type: "string", string: { type: "Format", fmt: "%s/64" } },
                      ],
                    },
                  ],
                },
                {
                  name: "subnet",
                  base: {
                    apiVersion: "ec2.aws.upbound.io/v1beta1",
                    kind: "Subnet",
                    spec: {
                      forProvider: {
                        region: "placeholder",
                        availabilityZone: "placeholder",
                        cidrBlock: "placeholder",
                        mapPublicIpOnLaunch: true,
                        assignIpv6AddressOnCreation: true,
                        vpcIdRef: { name: "placeholder" },
                      },
                      providerConfigRef: { name: "default" },
                    },
                  },
                  patches: [
                    // Deterministic MR name (== the XR name) so git-side
                    // resources can reference the subnet with a plain
                    // subnetIdRef {name} — composed resources otherwise get
                    // generated names no static manifest can point at.
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "metadata.name",
                      toFieldPath: "metadata.name",
                    },
                    // Plain Required copy: the value only exists once the
                    // write-side transform succeeded, so it is always a valid
                    // /64 here.
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "status.subnetIpv6Cidr",
                      toFieldPath: "spec.forProvider.ipv6CidrBlock",
                      policy: { fromFieldPath: "Required" },
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.region",
                      toFieldPath: "spec.forProvider.region",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.availabilityZone",
                      toFieldPath: "spec.forProvider.availabilityZone",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.cidrBlock",
                      toFieldPath: "spec.forProvider.cidrBlock",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.mapPublicIpOnLaunch",
                      toFieldPath: "spec.forProvider.mapPublicIpOnLaunch",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.tags",
                      toFieldPath: "spec.forProvider.tags",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.vpcMrName",
                      toFieldPath: "spec.forProvider.vpcIdRef.name",
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

/** An XR instance: one dual-stack subnet derived from one Vpc. */
export class DualStackSubnet extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: DualStackSubnetConfig) {
    super(scope, id);
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XDualStackSubnet",
      metadata: { name: id },
      spec: {
        vpcMrName: config.vpcMrName,
        region: config.region,
        availabilityZone: config.availabilityZone,
        cidrBlock: config.cidrBlock,
        mapPublicIpOnLaunch: config.mapPublicIpOnLaunch ?? true,
        ...(config.tags ? { tags: config.tags } : {}),
        kubeProviderConfigName:
          config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}
