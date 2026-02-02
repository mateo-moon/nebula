import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * CertManager XRD and Composition.
 * 
 * Creates:
 * - Helm Release (cert-manager)
 * - ClusterIssuers (selfsigned, letsencrypt-stage, letsencrypt-prod)
 * 
 * @example
 * ```yaml
 * apiVersion: nebula.io/v1alpha1
 * kind: CertManager
 * metadata:
 *   name: cert-manager
 * spec:
 *   acmeEmail: admin@example.com
 *   version: v1.15.2
 * ```
 */
export class CertManagerXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xcertmanagers.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XCertManager',
          plural: 'xcertmanagers',
        },
        claimNames: {
          kind: 'CertManager',
          plural: 'certmanagers',
        },
        defaultCompositionRef: {
          name: 'cert-manager-v1',
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
                    required: ['acmeEmail'],
                    properties: {
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., cert-manager-v1, cert-manager-v2)',
                          },
                        },
                      },
                      acmeEmail: {
                        type: 'string',
                        description: 'Email address for ACME (Let\'s Encrypt) registration',
                      },
                      namespace: {
                        type: 'string',
                        default: 'cert-manager',
                        description: 'Namespace to deploy cert-manager',
                      },
                      version: {
                        type: 'string',
                        default: 'v1.15.2',
                        description: 'Helm chart version',
                      },
                      repository: {
                        type: 'string',
                        default: 'https://charts.jetstack.io',
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
                      ready: {
                        type: 'boolean',
                        description: 'Whether cert-manager is ready',
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
        name: 'cert-manager-v1',
        labels: {
          'crossplane.io/xrd': 'xcertmanagers.nebula.io',
          'nebula.io/version': 'v1',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XCertManager',
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
                // Helm Release
                {
                  name: 'helm-release',
                  base: {
                    apiVersion: 'helm.crossplane.io/v1beta1',
                    kind: 'Release',
                    spec: {
                      forProvider: {
                        chart: {
                          name: 'cert-manager',
                          repository: 'https://charts.jetstack.io',
                        },
                        namespace: 'cert-manager',
                        wait: true,
                        values: {
                          installCRDs: true,
                          prometheus: { enabled: true },
                        },
                      },
                    },
                  },
                  patches: [
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.providerConfigRef',
                      toFieldPath: 'spec.providerConfigRef.name',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.namespace',
                      toFieldPath: 'spec.forProvider.namespace',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.version',
                      toFieldPath: 'spec.forProvider.chart.version',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'spec.repository',
                      toFieldPath: 'spec.forProvider.chart.repository',
                    },
                    {
                      type: 'FromCompositeFieldPath',
                      fromFieldPath: 'metadata.name',
                      toFieldPath: 'metadata.name',
                      transforms: [
                        { type: 'string', string: { type: 'Format', fmt: '%s-helm' } },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          // ClusterIssuers via go-templating
          {
            step: 'cluster-issuers',
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
{{- $namespace := default "cert-manager" $spec.namespace }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ $xr.metadata.name }}-selfsigned-issuer
  annotations:
    crossplane.io/external-name: selfsigned
spec:
  forProvider:
    manifest:
      apiVersion: cert-manager.io/v1
      kind: ClusterIssuer
      metadata:
        name: selfsigned
      spec:
        selfSigned: {}
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ $xr.metadata.name }}-letsencrypt-stage
  annotations:
    crossplane.io/external-name: letsencrypt-stage
spec:
  forProvider:
    manifest:
      apiVersion: cert-manager.io/v1
      kind: ClusterIssuer
      metadata:
        name: letsencrypt-stage
      spec:
        acme:
          email: {{ $spec.acmeEmail }}
          server: https://acme-staging-v02.api.letsencrypt.org/directory
          privateKeySecretRef:
            name: letsencrypt-stage-private-key
          solvers:
            - http01:
                ingress:
                  class: nginx
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ $xr.metadata.name }}-letsencrypt-prod
  annotations:
    crossplane.io/external-name: letsencrypt-prod
spec:
  forProvider:
    manifest:
      apiVersion: cert-manager.io/v1
      kind: ClusterIssuer
      metadata:
        name: letsencrypt-prod
      spec:
        acme:
          email: {{ $spec.acmeEmail }}
          server: https://acme-v02.api.letsencrypt.org/directory
          privateKeySecretRef:
            name: letsencrypt-prod-private-key
          solvers:
            - http01:
                ingress:
                  class: nginx
  providerConfigRef:
    name: {{ default "default" $spec.providerConfigRef }}
`,
              },
            },
          },
        ],
      },
    });
  }
}
