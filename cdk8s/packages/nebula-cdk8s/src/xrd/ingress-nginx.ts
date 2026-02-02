import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * IngressNginx XRD and Composition.
 * 
 * Creates:
 * - GCP Static IP (optional)
 * - cert-manager Issuer (for admission webhook)
 * - Helm Release (ingress-nginx)
 * 
 * @example
 * ```yaml
 * apiVersion: nebula.io/v1alpha1
 * kind: IngressNginx
 * metadata:
 *   name: ingress-nginx
 * spec:
 *   project: my-project
 *   region: europe-west3
 *   createStaticIp: true
 * ```
 */
export class IngressNginxXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xingressnginxs.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XIngressNginx',
          plural: 'xingressnginxs',
        },
        claimNames: {
          kind: 'IngressNginx',
          plural: 'ingressnginxs',
        },
        defaultCompositionRef: {
          name: 'ingress-nginx-v1',
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
                    required: ['project', 'region'],
                    properties: {
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., ingress-nginx-v1, ingress-nginx-v2)',
                          },
                        },
                      },
                      project: {
                        type: 'string',
                        description: 'GCP project ID',
                      },
                      region: {
                        type: 'string',
                        description: 'GCP region for static IP',
                      },
                      namespace: {
                        type: 'string',
                        default: 'ingress-nginx',
                        description: 'Namespace to deploy ingress-nginx',
                      },
                      createStaticIp: {
                        type: 'boolean',
                        default: false,
                        description: 'Create a static IP for the LoadBalancer',
                      },
                      staticIpName: {
                        type: 'string',
                        description: 'Name for the static IP resource',
                      },
                      controller: {
                        type: 'object',
                        description: 'Controller configuration',
                        properties: {
                          replicaCount: {
                            type: 'integer',
                            description: 'Number of controller replicas',
                          },
                          service: {
                            type: 'object',
                            properties: {
                              type: {
                                type: 'string',
                                enum: ['LoadBalancer', 'NodePort', 'ClusterIP'],
                                default: 'LoadBalancer',
                              },
                              externalTrafficPolicy: {
                                type: 'string',
                                enum: ['Local', 'Cluster'],
                                default: 'Local',
                              },
                            },
                          },
                        },
                      },
                      version: {
                        type: 'string',
                        default: '4.14.2',
                        description: 'Helm chart version',
                      },
                      repository: {
                        type: 'string',
                        default: 'https://kubernetes.github.io/ingress-nginx',
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
                      staticIpAddress: {
                        type: 'string',
                        description: 'Allocated static IP address',
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
        name: 'ingress-nginx-v1',
        labels: {
          'crossplane.io/xrd': 'xingressnginxs.nebula.io',
          'nebula.io/version': 'v1',
          provider: 'gcp',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XIngressNginx',
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
                // GCP Static IP (conditional via go-templating)
              ],
            },
          },
          // Static IP + Helm Release via go-templating
          {
            step: 'resources',
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
{{- $namespace := default "ingress-nginx" $spec.namespace }}
{{- $staticIpName := default (printf "%s-ingress-ip" $xr.metadata.name) $spec.staticIpName }}

{{- if $spec.createStaticIp }}
---
apiVersion: compute.gcp.upbound.io/v1beta1
kind: Address
metadata:
  name: {{ $staticIpName }}
  annotations:
    crossplane.io/external-name: {{ $staticIpName }}
spec:
  forProvider:
    project: {{ $spec.project }}
    region: {{ $spec.region }}
    addressType: EXTERNAL
    description: Static IP for Ingress Nginx LoadBalancer
{{- end }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ $xr.metadata.name }}-selfsigned-issuer
  annotations:
    crossplane.io/external-name: ingress-nginx-selfsigned
spec:
  forProvider:
    manifest:
      apiVersion: cert-manager.io/v1
      kind: Issuer
      metadata:
        name: ingress-nginx-selfsigned
        namespace: {{ $namespace }}
      spec:
        selfSigned: {}
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
---
apiVersion: helm.crossplane.io/v1beta1
kind: Release
metadata:
  name: {{ $xr.metadata.name }}-helm
  annotations:
    crossplane.io/external-name: ingress-nginx
spec:
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
  forProvider:
    chart:
      name: ingress-nginx
      repository: {{ default "https://kubernetes.github.io/ingress-nginx" $spec.repository }}
      version: {{ default "4.14.2" $spec.version }}
    namespace: {{ $namespace }}
    values:
      controller:
        {{- if $spec.controller }}
        {{- if $spec.controller.replicaCount }}
        replicaCount: {{ $spec.controller.replicaCount }}
        {{- end }}
        {{- end }}
        tolerations:
          - key: components.gke.io/gke-managed-components
            operator: Exists
            effect: NoSchedule
        service:
          {{- if and $spec.controller $spec.controller.service }}
          type: {{ default "LoadBalancer" $spec.controller.service.type }}
          externalTrafficPolicy: {{ default "Local" $spec.controller.service.externalTrafficPolicy }}
          {{- else }}
          type: LoadBalancer
          externalTrafficPolicy: Local
          {{- end }}
          {{- if $spec.createStaticIp }}
          annotations:
            cloud.google.com/load-balancer-ip: {{ $staticIpName }}
          {{- end }}
        admissionWebhooks:
          certManager:
            enabled: true
            issuerRef:
              name: ingress-nginx-selfsigned
              kind: Issuer
              group: cert-manager.io
          patch:
            enabled: false
`,
              },
            },
          },
        ],
      },
    });
  }
}
