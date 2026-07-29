/**
 * EIP-derived DNS A record via Crossplane Composition.
 *
 * Derives a Route53 A record from a Crossplane-managed Eip's OBSERVED public
 * IP — no hardcoded address in git. The Eip lives wherever its lifecycle
 * belongs (e.g. a cluster definition); this Composition observes that MR on
 * the local cluster (provider-kubernetes Observe Object) and renders the
 * Record with function-go-templating once `status.atProvider.publicIp` exists.
 *
 * Split like {@link ArgoCdClusterSyncSetup}:
 * - `EipDnsRecordSetup` — the shared XRD + Composition (install once)
 * - `EipDnsRecord` — an XR instance (per record)
 *
 * Prerequisites: provider-kubernetes (+ a ProviderConfig and RBAC to read
 * eips.ec2.aws.upbound.io — see KubernetesProviderRbacOptions.extraReadRules),
 * function-patch-and-transform, function-go-templating.
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

export interface EipDnsRecordConfig {
  /** metadata.name of the Eip managed resource to observe (cluster-scoped). */
  eipName: string;
  /** Fully-qualified record name, e.g. "p2p-hoodi-1.nuconstruct.xyz". */
  dnsName: string;
  /** metadata.name of the Zone managed resource the record belongs to (zoneIdRef). */
  zoneMrName: string;
  /** Record TTL in seconds (default 60). */
  ttl?: number;
  /** provider-aws ProviderConfig name (default "default"). */
  awsProviderConfigName?: string;
  /** provider-kubernetes ProviderConfig name (default "kubernetes-provider-config"). */
  kubeProviderConfigName?: string;
}

/** The shared XRD + Composition. Install once (e.g. alongside the DNS zones). */
export class EipDnsRecordSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xeipdnsrecords.nebula.io",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10" },
      },
      spec: {
        group: "nebula.io",
        names: { kind: "XEipDnsRecord", plural: "xeipdnsrecords" },
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
                      "dnsName",
                      "zoneMrName",
                      "ttl",
                      "awsProviderConfigName",
                      "kubeProviderConfigName",
                    ],
                    properties: {
                      eipName: {
                        type: "string",
                        description: "Eip managed-resource name to observe",
                      },
                      dnsName: {
                        type: "string",
                        description: "Fully-qualified A record name",
                      },
                      zoneMrName: {
                        type: "string",
                        description: "Zone managed-resource name (zoneIdRef)",
                      },
                      ttl: { type: "integer", description: "Record TTL" },
                      awsProviderConfigName: {
                        type: "string",
                        description: "provider-aws ProviderConfig name",
                      },
                      kubeProviderConfigName: {
                        type: "string",
                        description: "provider-kubernetes ProviderConfig name",
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

    // Rendered only once the observed Eip reports its allocated address —
    // until then the XR simply composes nothing (no record with a wrong IP).
    // allowOverwrite adopts a pre-existing rrset (e.g. one previously managed
    // as a static Record) instead of failing "already exists".
    const recordTemplate = `
{{- if .observed.resources }}
{{- $eip := index .observed.resources "eip" }}
{{- if and $eip $eip.resource $eip.resource.status $eip.resource.status.atProvider $eip.resource.status.atProvider.manifest }}
{{- $obs := $eip.resource.status.atProvider.manifest }}
{{- if and $obs.status $obs.status.atProvider $obs.status.atProvider.publicIp }}
apiVersion: route53.aws.upbound.io/v1beta2
kind: Record
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: record
spec:
  forProvider:
    zoneIdRef:
      name: {{ .observed.composite.resource.spec.zoneMrName }}
    name: {{ .observed.composite.resource.spec.dnsName }}
    type: A
    ttl: {{ .observed.composite.resource.spec.ttl }}
    allowOverwrite: true
    records:
      - {{ $obs.status.atProvider.publicIp }}
  providerConfigRef:
    name: {{ .observed.composite.resource.spec.awsProviderConfigName }}
{{- end }}
{{- end }}
{{- end }}
`.trim();

    this.composition = new Composition(this, "composition", {
      metadata: {
        name: "eip-dns-record",
        annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: "-5" },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XEipDnsRecord",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "observe-eip",
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
            step: "auto-ready",
            functionRef: { name: "function-auto-ready" },
          },
        ],
                },
              ],
            },
          },
          {
            step: "render-record",
            functionRef: { name: "function-go-templating" },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: { template: recordTemplate },
            },
          },
        ],
      },
    });
  }
}

/** An XR instance deriving one A record from one Eip. Requires {@link EipDnsRecordSetup}. */
export class EipDnsRecord extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: EipDnsRecordConfig) {
    super(scope, id);

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XEipDnsRecord",
      metadata: { name: id },
      spec: {
        eipName: config.eipName,
        dnsName: config.dnsName,
        zoneMrName: config.zoneMrName,
        ttl: config.ttl ?? 60,
        awsProviderConfigName: config.awsProviderConfigName ?? "default",
        kubeProviderConfigName:
          config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}
