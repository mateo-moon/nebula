import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * Dns XRD and Composition.
 * 
 * Creates:
 * - GCP Cloud DNS ManagedZone
 * - Cloudflare NS delegation records (optional)
 * 
 * The zone nameservers are automatically delegated to Cloudflare if configured.
 * 
 * @example
 * ```yaml
 * apiVersion: nebula.io/v1alpha1
 * kind: Dns
 * metadata:
 *   name: my-dns
 *   namespace: default
 * spec:
 *   project: my-project
 *   domain: example.com
 *   delegations:
 *     - provider: cloudflare
 *       zoneId: abc123
 * ```
 */
export class DnsXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xdns.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XDns',
          plural: 'xdns',
        },
        claimNames: {
          kind: 'Dns',
          plural: 'dns',
        },
        defaultCompositionRef: {
          name: 'dns-v1',
        },
        connectionSecretKeys: [
          'nameServers',
        ],
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
                    required: ['project', 'domain'],
                    properties: {
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., dns-v1, dns-v2)',
                          },
                        },
                      },
                      project: {
                        type: 'string',
                        description: 'GCP project ID',
                      },
                      domain: {
                        type: 'string',
                        description: 'Domain name to manage (e.g., example.com)',
                      },
                      description: {
                        type: 'string',
                        default: 'Managed by Crossplane',
                        description: 'Description for the DNS zone',
                      },
                      delegations: {
                        type: 'array',
                        description: 'External DNS providers to delegate NS records to',
                        items: {
                          type: 'object',
                          required: ['provider'],
                          properties: {
                            provider: {
                              type: 'string',
                              enum: ['cloudflare'],
                              description: 'Delegation provider (cloudflare)',
                            },
                            zoneId: {
                              type: 'string',
                              description: 'Zone ID in the delegation provider',
                            },
                            providerConfigRef: {
                              type: 'string',
                              default: 'default',
                              description: 'ProviderConfig reference for the delegation provider',
                            },
                            ttl: {
                              type: 'integer',
                              default: 3600,
                              description: 'TTL for NS records',
                            },
                          },
                        },
                      },
                    },
                  },
                  status: {
                    type: 'object',
                    properties: {
                      zoneId: {
                        type: 'string',
                        description: 'GCP DNS zone ID',
                      },
                      nameServers: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Zone nameservers',
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
        name: 'dns-v1',
        labels: {
          'crossplane.io/xrd': 'xdns.nebula.io',
          'nebula.io/version': 'v1',
          provider: 'gcp',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XDns',
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          // Step 1: Create GCP ManagedZone
          {
            step: 'patch-and-transform',
            functionRef: {
              name: 'crossplane-contrib-function-patch-and-transform',
            },
            input: {
              apiVersion: 'pt.fn.crossplane.io/v1beta1',
              kind: 'Resources',
              resources: [
                {
                  name: 'managed-zone',
                  base: {
                    apiVersion: 'dns.gcp.upbound.io/v1beta1',
                    kind: 'ManagedZone',
                    spec: {
                      forProvider: {
                        dnsName: '',  // patched
                        description: '',  // patched
                      },
                    },
                  },
                  patches: [
                    // Zone name from XR name
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.name',
                      transforms: [
                        {
                          type: 'string',
                          string: {
                            fmt: '%s-zone',
                          },
                        },
                      ],
                    },
                    // External name
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.annotations[crossplane.io/external-name]',
                      transforms: [
                        {
                          type: 'string',
                          string: {
                            fmt: '%s-zone',
                          },
                        },
                      ],
                    },
                    // GCP Project
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.project',
                      toFieldPath: 'spec.forProvider.project',
                    },
                    // DNS Name (domain with trailing dot)
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.domain',
                      toFieldPath: 'spec.forProvider.dnsName',
                      transforms: [
                        {
                          type: 'string',
                          string: {
                            fmt: '%s.',
                          },
                        },
                      ],
                    },
                    // Description
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.description',
                      toFieldPath: 'spec.forProvider.description',
                    },
                    // Write nameservers to status
                    {
                      type: 'ToCompositeFieldPath',
                      fromFieldPath: 'status.atProvider.nameServers',
                      toFieldPath: 'status.nameServers',
                    },
                    // Write zone ID to status
                    {
                      type: 'ToCompositeFieldPath',
                      fromFieldPath: 'status.atProvider.id',
                      toFieldPath: 'status.zoneId',
                    },
                  ],
                },
              ],
            },
          },
          // Step 2: Create Cloudflare NS records (dynamic based on delegations)
          {
            step: 'cloudflare-delegation',
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
{{- $status := $xr.status }}
{{- $nameServers := $status.nameServers }}

{{/* Skip if no delegations or no nameservers yet */}}
{{- if and $spec.delegations $nameServers }}
{{- range $dIdx, $delegation := $spec.delegations }}
{{- if eq $delegation.provider "cloudflare" }}
{{/* Create NS record for each nameserver */}}
{{- range $nsIdx, $ns := $nameServers }}
---
apiVersion: dns.cloudflare.crossplane.io/v1alpha1
kind: Record
metadata:
  name: {{ $xr.metadata.name }}-ns-{{ $dIdx }}-{{ $nsIdx }}
  annotations:
    crossplane.io/external-name: {{ $xr.metadata.name }}-ns-{{ $dIdx }}-{{ $nsIdx }}
spec:
  forProvider:
    zoneId: {{ $delegation.zoneId }}
    name: {{ $spec.domain }}
    type: NS
    content: {{ $ns }}
    ttl: {{ default 3600 $delegation.ttl }}
  providerConfigRef:
    name: {{ default "default" $delegation.providerConfigRef }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
`,
              },
            },
          },
        ],
      },
    });
  }
}
