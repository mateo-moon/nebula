import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * ExternalDns XRD and Composition.
 * 
 * Creates:
 * - GCP Service Account (for Workload Identity)
 * - IAM bindings (Workload Identity + dns.admin)
 * - Helm Release (external-dns)
 * 
 * @example
 * ```yaml
 * apiVersion: nebula.io/v1alpha1
 * kind: ExternalDns
 * metadata:
 *   name: external-dns
 * spec:
 *   project: my-project
 *   domainFilters:
 *     - example.com
 *   policy: sync
 * ```
 */
export class ExternalDnsXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xexternaldns.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XExternalDns',
          plural: 'xexternaldns',
        },
        claimNames: {
          kind: 'ExternalDns',
          plural: 'externaldns',
        },
        defaultCompositionRef: {
          name: 'external-dns-v1',
        },
        versions: [
          {
            name: 'v1alpha1',
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: 'object',
                properties: {
                  spec: {
                    type: 'object',
                    required: ['project'],
                    properties: {
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., external-dns-v1, external-dns-v2)',
                          },
                        },
                      },
                      project: {
                        type: 'string',
                        description: 'GCP project ID',
                      },
                      namespace: {
                        type: 'string',
                        default: 'external-dns',
                        description: 'Namespace to deploy external-dns',
                      },
                      domainFilters: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Domains to manage DNS for',
                      },
                      policy: {
                        type: 'string',
                        enum: ['sync', 'upsert-only'],
                        default: 'upsert-only',
                        description: 'DNS record management policy',
                      },
                      sources: {
                        type: 'array',
                        items: { type: 'string' },
                        default: ['service', 'ingress'],
                        description: 'Kubernetes resources to watch',
                      },
                      txtOwnerId: {
                        type: 'string',
                        description: 'TXT record owner ID',
                      },
                      txtPrefix: {
                        type: 'string',
                        description: 'TXT record prefix',
                      },
                      version: {
                        type: 'string',
                        description: 'Helm chart version',
                      },
                      repository: {
                        type: 'string',
                        default: 'https://kubernetes-sigs.github.io/external-dns/',
                        description: 'Helm repository URL',
                      },
                      values: {
                        type: 'object',
                        'x-kubernetes-preserve-unknown-fields': true,
                        description: 'Additional Helm values to merge',
                      },
                      providerConfigRef: {
                        type: 'string',
                        default: 'default',
                        description: 'Helm ProviderConfig reference for target cluster',
                      },
                    },
                  },
                  status: {
                    type: 'object',
                    properties: {
                      gsaEmail: {
                        type: 'string',
                        description: 'GCP Service Account email',
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

    // ==================== COMPOSITION ====================
    this.composition = new Composition(this, 'composition', {
      metadata: {
        name: 'external-dns-v1',
        labels: {
          'crossplane.io/xrd': 'xexternaldns.nebula.io',
          'nebula.io/version': 'v1',
          provider: 'gcp',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XExternalDns',
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: 'patch-and-transform',
            functionRef: {
              name: 'crossplane-contrib-function-patch-and-transform',
            },
            input: {
              apiVersion: 'pt.fn.crossplane.io/v1beta1',
              kind: 'Resources',
              resources: [
                // GCP Service Account
                {
                  name: 'gcp-service-account',
                  base: {
                    apiVersion: 'cloudplatform.gcp.upbound.io/v1beta1',
                    kind: 'ServiceAccount',
                    spec: {
                      forProvider: {},
                    },
                  },
                  patches: [
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.project',
                      toFieldPath: 'spec.forProvider.project',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.name',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s-external-dns' } },
                      ],
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'spec.forProvider.displayName',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s external-dns' } },
                      ],
                    },
                    {
                      type: 'ToCompositeFieldPath',
                      fromFieldPath: 'status.atProvider.email',
                      toFieldPath: 'status.gsaEmail',
                    },
                  ],
                },
                // Workload Identity IAM binding
                {
                  name: 'workload-identity-binding',
                  base: {
                    apiVersion: 'cloudplatform.gcp.upbound.io/v1beta1',
                    kind: 'ServiceAccountIAMMember',
                    spec: {
                      forProvider: {
                        role: 'roles/iam.workloadIdentityUser',
                      },
                    },
                  },
                  patches: [
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.name',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s-wi-binding' } },
                      ],
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'spec.forProvider.serviceAccountIdRef.name',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s-external-dns' } },
                      ],
                    },
                    {
                      type: 'CombineFromComposite',
                      combine: {
                        variables: [
                          { fromFieldPath: 'spec.project' },
                          { fromFieldPath: 'spec.namespace' },
                        ],
                        strategy: 'string',
                        string: { fmt: 'serviceAccount:%s.svc.id.goog[%s/external-dns]' },
                      },
                      toFieldPath: 'spec.forProvider.member',
                    },
                  ],
                },
                // DNS Admin IAM binding
                {
                  name: 'dns-admin-binding',
                  base: {
                    apiVersion: 'cloudplatform.gcp.upbound.io/v1beta1',
                    kind: 'ProjectIAMMember',
                    spec: {
                      forProvider: {
                        role: 'roles/dns.admin',
                      },
                    },
                  },
                  patches: [
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.project',
                      toFieldPath: 'spec.forProvider.project',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.name',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s-dns-admin' } },
                      ],
                    },
                    {
                      type: 'CombineFromComposite',
                      combine: {
                        variables: [
                          { fromFieldPath: 'metadata.name' },
                          { fromFieldPath: 'spec.project' },
                        ],
                        strategy: 'string',
                        string: { fmt: 'serviceAccount:%s-external-dns@%s.iam.gserviceaccount.com' },
                      },
                      toFieldPath: 'spec.forProvider.member',
                    },
                  ],
                },
              ],
            },
          },
          // Helm Release via go-templating (needs GSA email interpolation)
          {
            step: 'helm-release',
            functionRef: {
              name: 'crossplane-contrib-function-go-templating',
            },
            input: {
              apiVersion: 'gotemplating.fn.crossplane.io/v1beta1',
              kind: 'GoTemplate',
              source: 'Inline',
              inline: {
                template: `
{{- $xr := .observed.composite.resource }}
{{- $spec := $xr.spec }}
{{- $namespace := default "external-dns" $spec.namespace }}
{{- $gsaEmail := printf "%s-external-dns@%s.iam.gserviceaccount.com" $xr.metadata.name $spec.project }}
---
apiVersion: helm.crossplane.io/v1beta1
kind: Release
metadata:
  name: {{ $xr.metadata.name }}-helm
  annotations:
    crossplane.io/external-name: external-dns
spec:
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
  forProvider:
    chart:
      name: external-dns
      repository: {{ default "https://kubernetes-sigs.github.io/external-dns/" $spec.repository }}
      {{- if $spec.version }}
      version: {{ $spec.version }}
      {{- end }}
    namespace: {{ $namespace }}
    values:
      provider: google
      sources:
        {{- range default (list "service" "ingress") $spec.sources }}
        - {{ . }}
        {{- end }}
      policy: {{ default "upsert-only" $spec.policy }}
      registry: txt
      interval: 1m
      logLevel: info
      {{- if $spec.domainFilters }}
      domainFilters:
        {{- range $spec.domainFilters }}
        - {{ . }}
        {{- end }}
      {{- end }}
      {{- if $spec.txtOwnerId }}
      txtOwnerId: {{ $spec.txtOwnerId }}
      {{- end }}
      {{- if $spec.txtPrefix }}
      txtPrefix: {{ $spec.txtPrefix }}
      {{- end }}
      serviceAccount:
        create: true
        name: external-dns
        annotations:
          iam.gke.io/gcp-service-account: {{ $gsaEmail }}
      extraArgs:
        - --google-project={{ $spec.project }}
      tolerations:
        - key: components.gke.io/gke-managed-components
          operator: Exists
          effect: NoSchedule
`,
              },
            },
          },
        ],
      },
    });
  }
}
