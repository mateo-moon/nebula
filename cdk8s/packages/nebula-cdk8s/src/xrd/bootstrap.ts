import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * Bootstrap XRD and Composition.
 * 
 * Creates all ProviderConfigs needed for the Nebula platform:
 * - GCP ProviderConfig (Secret or WorkloadIdentity based on clusterType)
 * - Helm ProviderConfig
 * - Cloudflare ProviderConfig (optional)
 * - Kubernetes ProviderConfig
 * 
 * ## Local Bootstrap Setup (using Application Default Credentials)
 * 
 * ```bash
 * # 1. Login with gcloud (one-time)
 * gcloud auth application-default login
 * 
 * # 2. Create secret from your ADC
 * kubectl create secret generic gcp-adc \
 *   -n crossplane-system \
 *   --from-file=credentials.json=$HOME/.config/gcloud/application_default_credentials.json
 * ```
 * 
 * @example
 * ```yaml
 * # For local bootstrap cluster (ephemeral, not in Git)
 * apiVersion: nebula.io/v1alpha1
 * kind: Bootstrap
 * metadata:
 *   name: platform
 * spec:
 *   clusterType: local
 *   gcp:
 *     project: my-project
 *     # Uses gcp-adc secret by default (Application Default Credentials)
 * ---
 * # For managed GKE cluster (in Git, synced by ArgoCD)
 * apiVersion: nebula.io/v1alpha1
 * kind: Bootstrap
 * metadata:
 *   name: platform
 * spec:
 *   clusterType: gke
 *   gcp:
 *     project: my-project
 *     # No secretRef needed - uses Workload Identity
 * ```
 */
export class BootstrapXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xbootstraps.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XBootstrap',
          plural: 'xbootstraps',
        },
        claimNames: {
          kind: 'Bootstrap',
          plural: 'bootstraps',
        },
        defaultCompositionRef: {
          name: 'bootstrap-v1',
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
                    required: ['clusterType', 'gcp'],
                    properties: {
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., bootstrap-v1)',
                          },
                        },
                      },
                      clusterType: {
                        type: 'string',
                        enum: ['local', 'gke'],
                        description: 'Type of cluster: local (uses Secret) or gke (uses WorkloadIdentity)',
                      },
                      // GCP Provider Config
                      gcp: {
                        type: 'object',
                        required: ['project'],
                        description: 'GCP ProviderConfig settings',
                        properties: {
                          project: {
                            type: 'string',
                            description: 'GCP project ID',
                          },
                          providerConfigName: {
                            type: 'string',
                            default: 'default',
                            description: 'Name for the GCP ProviderConfig',
                          },
                          secretRef: {
                            type: 'object',
                            description: 'Secret reference for credentials (required for clusterType: local)',
                            properties: {
                              name: {
                                type: 'string',
                                default: 'gcp-adc',
                                description: 'Secret name (default: gcp-adc for Application Default Credentials)',
                              },
                              namespace: {
                                type: 'string',
                                default: 'crossplane-system',
                                description: 'Secret namespace',
                              },
                              key: {
                                type: 'string',
                                default: 'credentials.json',
                                description: 'Key in the secret',
                              },
                            },
                          },
                        },
                      },
                      // Helm Provider Config
                      helm: {
                        type: 'object',
                        description: 'Helm ProviderConfig settings',
                        properties: {
                          providerConfigName: {
                            type: 'string',
                            default: 'default',
                            description: 'Name for the Helm ProviderConfig',
                          },
                        },
                      },
                      // Kubernetes Provider Config
                      kubernetes: {
                        type: 'object',
                        description: 'Kubernetes ProviderConfig settings',
                        properties: {
                          providerConfigName: {
                            type: 'string',
                            default: 'default',
                            description: 'Name for the Kubernetes ProviderConfig',
                          },
                        },
                      },
                      // Cloudflare Provider Config (optional)
                      cloudflare: {
                        type: 'object',
                        description: 'Cloudflare ProviderConfig settings (optional)',
                        properties: {
                          enabled: {
                            type: 'boolean',
                            default: false,
                            description: 'Enable Cloudflare provider',
                          },
                          providerConfigName: {
                            type: 'string',
                            default: 'default',
                            description: 'Name for the Cloudflare ProviderConfig',
                          },
                          secretRef: {
                            type: 'object',
                            description: 'Secret reference for Cloudflare API token',
                            properties: {
                              name: {
                                type: 'string',
                                default: 'cloudflare-credentials',
                                description: 'Secret name',
                              },
                              namespace: {
                                type: 'string',
                                default: 'crossplane-system',
                                description: 'Secret namespace',
                              },
                              key: {
                                type: 'string',
                                default: 'api-token',
                                description: 'Key in the secret',
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  status: {
                    type: 'object',
                    properties: {
                      gcpProviderConfigReady: {
                        type: 'boolean',
                        description: 'GCP ProviderConfig is ready',
                      },
                      helmProviderConfigReady: {
                        type: 'boolean',
                        description: 'Helm ProviderConfig is ready',
                      },
                      kubernetesProviderConfigReady: {
                        type: 'boolean',
                        description: 'Kubernetes ProviderConfig is ready',
                      },
                      cloudflareProviderConfigReady: {
                        type: 'boolean',
                        description: 'Cloudflare ProviderConfig is ready',
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
        name: 'bootstrap-v1',
        labels: {
          'crossplane.io/xrd': 'xbootstraps.nebula.io',
          'nebula.io/version': 'v1',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XBootstrap',
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          // Generate all ProviderConfigs via Go templating
          {
            step: 'provider-configs',
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
{{- $clusterType := $spec.clusterType }}

{{/* ==================== GCP ProviderConfig ==================== */}}
{{- $gcpName := default "default" $spec.gcp.providerConfigName }}
---
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: {{ $gcpName }}
  annotations:
    crossplane.io/external-name: {{ $gcpName }}
spec:
  projectID: {{ $spec.gcp.project }}
{{- if eq $clusterType "local" }}
  credentials:
    source: Secret
    secretRef:
      namespace: {{ default "crossplane-system" $spec.gcp.secretRef.namespace }}
      name: {{ default "gcp-adc" $spec.gcp.secretRef.name }}
      key: {{ default "credentials.json" $spec.gcp.secretRef.key }}
{{- else if eq $clusterType "gke" }}
  credentials:
    source: InjectedIdentity
{{- end }}

{{/* ==================== Helm ProviderConfig ==================== */}}
{{- $helmName := "default" }}
{{- if $spec.helm }}
{{- $helmName = default "default" $spec.helm.providerConfigName }}
{{- end }}
---
apiVersion: helm.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: {{ $helmName }}
  annotations:
    crossplane.io/external-name: {{ $helmName }}
spec:
  credentials:
    source: InjectedIdentity

{{/* ==================== Kubernetes ProviderConfig ==================== */}}
{{- $k8sName := "default" }}
{{- if $spec.kubernetes }}
{{- $k8sName = default "default" $spec.kubernetes.providerConfigName }}
{{- end }}
---
apiVersion: kubernetes.crossplane.io/v1alpha1
kind: ProviderConfig
metadata:
  name: {{ $k8sName }}
  annotations:
    crossplane.io/external-name: {{ $k8sName }}
spec:
  credentials:
    source: InjectedIdentity

{{/* ==================== Cloudflare ProviderConfig (optional) ==================== */}}
{{- if and $spec.cloudflare $spec.cloudflare.enabled }}
{{- $cfName := default "default" $spec.cloudflare.providerConfigName }}
---
apiVersion: cloudflare.crossplane.io/v1alpha1
kind: ProviderConfig
metadata:
  name: {{ $cfName }}
  annotations:
    crossplane.io/external-name: {{ $cfName }}
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: {{ default "crossplane-system" $spec.cloudflare.secretRef.namespace }}
      name: {{ default "cloudflare-credentials" $spec.cloudflare.secretRef.name }}
      key: {{ default "api-token" $spec.cloudflare.secretRef.key }}
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
