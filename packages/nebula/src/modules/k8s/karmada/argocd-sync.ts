/**
 * Karmada ArgoCD Credential Sync via Crossplane Composition.
 *
 * Uses provider-kubernetes Object (Observe mode) to watch the Karmada admin
 * kubeconfig secret and function-go-templating to extract TLS credentials
 * and compose them into the ArgoCD cluster secret.
 *
 * This ensures ArgoCD always has valid credentials to connect to the Karmada
 * API server, even after certificate rotation.
 *
 * Prerequisites:
 * - Crossplane with provider-kubernetes and function-go-templating installed
 *
 * @example
 * ```typescript
 * new KarmadaArgoCdSync(chart, 'argocd-sync', {
 *   apiServerUrl: 'https://karmada-apiserver.karmada-system.svc.cluster.local:5443',
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
  CompositeResourceDefinition,
  CompositeResourceDefinitionSpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";

export interface KarmadaArgoCdSyncConfig {
  /** Karmada namespace (default: 'karmada-system') */
  karmadaNamespace?: string;
  /** Name of the Karmada admin kubeconfig secret (default: 'karmada-admin-config') */
  kubeconfigSecretName?: string;
  /** Key in the kubeconfig secret (default: 'karmada.config') */
  kubeconfigSecretKey?: string;
  /** ArgoCD namespace (default: 'argocd') */
  argoCdNamespace?: string;
  /** ArgoCD cluster secret name (default: 'karmada-cluster') */
  argoCdSecretName?: string;
  /** Karmada API server URL */
  apiServerUrl: string;
  /** provider-kubernetes ProviderConfig name (default: 'kubernetes-provider-config') */
  kubeProviderConfigName?: string;
}

export class KarmadaArgoCdSync extends Construct {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: KarmadaArgoCdSyncConfig) {
    super(scope, id);

    const karmadaNamespace = config.karmadaNamespace ?? "karmada-system";
    const kubeconfigSecretName =
      config.kubeconfigSecretName ?? "karmada-admin-config";
    const kubeconfigSecretKey = config.kubeconfigSecretKey ?? "karmada.config";
    const argoCdNamespace = config.argoCdNamespace ?? "argocd";
    const argoCdSecretName = config.argoCdSecretName ?? "karmada-cluster";
    const kubeProviderConfigName =
      config.kubeProviderConfigName ?? "kubernetes-provider-config";

    this.xrd = this.createXrd();
    this.composition = this.createComposition();
    this.xr = this.createXr({
      karmadaNamespace,
      kubeconfigSecretName,
      kubeconfigSecretKey,
      argoCdNamespace,
      argoCdSecretName,
      apiServerUrl: config.apiServerUrl,
      kubeProviderConfigName,
    });
  }

  private createXrd(): CompositeResourceDefinition {
    return new CompositeResourceDefinition(this, "xrd", {
      metadata: {
        name: "xkarmadaargocdsyncs.nebula.io",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-10",
        },
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XKarmadaArgoCdSync",
          plural: "xkarmadaargocdsyncs",
        },
        scope: CompositeResourceDefinitionSpecScope.CLUSTER,
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
                      "apiServerUrl",
                      "karmadaNamespace",
                      "kubeconfigSecretName",
                      "kubeconfigSecretKey",
                      "argoCdNamespace",
                      "argoCdSecretName",
                      "kubeProviderConfigName",
                    ],
                    properties: {
                      apiServerUrl: {
                        type: "string",
                        description: "Karmada API server URL",
                      },
                      karmadaNamespace: {
                        type: "string",
                        description: "Namespace where Karmada is installed",
                      },
                      kubeconfigSecretName: {
                        type: "string",
                        description:
                          "Name of the Karmada admin kubeconfig secret",
                      },
                      kubeconfigSecretKey: {
                        type: "string",
                        description: "Key in the kubeconfig secret",
                      },
                      argoCdNamespace: {
                        type: "string",
                        description: "ArgoCD namespace",
                      },
                      argoCdSecretName: {
                        type: "string",
                        description: "Name of the ArgoCD cluster secret",
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
  }

  private createComposition(): Composition {
    // Go template that reads the observed Karmada kubeconfig secret,
    // extracts TLS credentials, and renders the ArgoCD cluster secret.
    //
    // The karmada-admin-config secret's .data values are base64-encoded by K8s.
    // Inside the kubeconfig YAML, TLS fields (certificate-authority-data, etc.)
    // are already base64-encoded. We decode the outer layer to parse the YAML,
    // then pass the inner base64 values directly to ArgoCD (which expects them
    // base64-encoded).
    const secretTemplate = `
apiVersion: v1
kind: Secret
metadata:
  name: {{ .observed.composite.resource.spec.argoCdSecretName }}
  namespace: {{ .observed.composite.resource.spec.argoCdNamespace }}
  labels:
    argocd.argoproj.io/secret-type: cluster
  annotations:
    argocd.argoproj.io/sync-wave: "10"
    gotemplating.fn.crossplane.io/composition-resource-name: argocd-cluster-secret
type: Opaque
{{- if .observed.resources }}
{{- $obj := index .observed.resources "karmada-kubeconfig" }}
{{- if and $obj $obj.resource $obj.resource.status $obj.resource.status.atProvider $obj.resource.status.atProvider.manifest }}
{{- $secretData := $obj.resource.status.atProvider.manifest.data }}
{{- $kubeconfigB64 := index $secretData "karmada.config" }}
{{- $kubeconfigYaml := $kubeconfigB64 | b64dec }}
{{- $kc := $kubeconfigYaml | fromYAML }}
{{- $cluster := (index $kc.clusters 0).cluster }}
{{- $user := (index $kc.users 0).user }}
stringData:
  name: karmada
  server: {{ .observed.composite.resource.spec.apiServerUrl }}
  config: |
    {"tlsClientConfig":{"insecure":false,"caData":"{{ index $cluster "certificate-authority-data" }}","certData":"{{ index $user "client-certificate-data" }}","keyData":"{{ index $user "client-key-data" }}"}}
{{- end }}
{{- end }}
`.trim();

    return new Composition(this, "composition", {
      metadata: {
        name: "karmada-argocd-sync",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-5",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XKarmadaArgoCdSync",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          // Step 1: Observe the Karmada kubeconfig secret via provider-kubernetes
          {
            step: "observe-kubeconfig",
            functionRef: {
              name: "function-patch-and-transform",
            },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                {
                  name: "karmada-kubeconfig",
                  base: {
                    apiVersion: "kubernetes.crossplane.io/v1alpha2",
                    kind: "Object",
                    spec: {
                      managementPolicies: ["Observe"],
                      forProvider: {
                        manifest: {
                          apiVersion: "v1",
                          kind: "Secret",
                          metadata: {
                            name: "placeholder",
                            namespace: "placeholder",
                          },
                        },
                      },
                    },
                  },
                  patches: [
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.kubeconfigSecretName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.karmadaNamespace",
                      toFieldPath:
                        "spec.forProvider.manifest.metadata.namespace",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.kubeProviderConfigName",
                      toFieldPath: "spec.providerConfigRef.name",
                    },
                  ],
                },
              ],
            },
          },
          // Step 2: Render the ArgoCD cluster secret with extracted TLS creds
          {
            step: "render-argocd-secret",
            functionRef: {
              name: "function-go-templating",
            },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: {
                template: secretTemplate,
              },
            },
          },
        ],
      },
    });
  }

  private createXr(
    config: Required<
      Omit<KarmadaArgoCdSyncConfig, "kubeProviderConfigName"> & {
        kubeProviderConfigName: string;
      }
    >,
  ): ApiObject {
    return new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XKarmadaArgoCdSync",
      metadata: {
        name: "karmada-argocd-sync",
        annotations: {
          "argocd.argoproj.io/sync-wave": "10",
        },
      },
      spec: {
        karmadaNamespace: config.karmadaNamespace,
        kubeconfigSecretName: config.kubeconfigSecretName,
        kubeconfigSecretKey: config.kubeconfigSecretKey,
        argoCdNamespace: config.argoCdNamespace,
        argoCdSecretName: config.argoCdSecretName,
        apiServerUrl: config.apiServerUrl,
        kubeProviderConfigName: config.kubeProviderConfigName,
      },
    });
  }
}
