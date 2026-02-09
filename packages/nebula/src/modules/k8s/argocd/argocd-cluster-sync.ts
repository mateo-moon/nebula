/**
 * Generic ArgoCD Cluster Credential Sync via Crossplane Composition.
 *
 * Observes a kubeconfig Secret (via provider-kubernetes in Observe mode),
 * extracts TLS credentials using function-go-templating, and renders an
 * ArgoCD cluster secret. Works for any cluster that stores its kubeconfig
 * as a Kubernetes Secret (e.g. CAPI clusters, Karmada).
 *
 * Split into two parts:
 * - `ArgoCdClusterSyncSetup` — creates the shared XRD + Composition (once)
 * - `ArgoCdClusterSync` — creates an XR instance (per cluster)
 *
 * Prerequisites:
 * - Crossplane with provider-kubernetes and function-go-templating installed
 *
 * @example
 * ```typescript
 * // In crossplane module (once):
 * new ArgoCdClusterSyncSetup(this, 'argocd-cluster-sync-setup');
 *
 * // Per cluster (apiServerUrl auto-extracted from kubeconfig):
 * new ArgoCdClusterSync(chart, 'dev-cluster-sync', {
 *   clusterName: 'dev-cluster',
 *   sourceSecretNamespace: 'default',
 *   sourceSecretName: 'dev-cluster-kubeconfig',
 *   sourceSecretKey: 'value',
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

export interface ArgoCdClusterSyncConfig {
  /** Human-readable cluster name (used in ArgoCD UI) */
  clusterName: string;
  /** Kubernetes API server URL for the target cluster. If omitted, extracted from the kubeconfig secret automatically. */
  apiServerUrl?: string;
  /** Namespace where the kubeconfig secret lives */
  sourceSecretNamespace: string;
  /** Name of the kubeconfig secret */
  sourceSecretName: string;
  /** Key in the secret containing the kubeconfig YAML (e.g. 'value', 'karmada.config') */
  sourceSecretKey: string;
  /** ArgoCD namespace (default: 'argocd') */
  argoCdNamespace?: string;
  /** ArgoCD cluster secret name (default: clusterName) */
  argoCdSecretName?: string;
  /** provider-kubernetes ProviderConfig name (default: 'kubernetes-provider-config') */
  kubeProviderConfigName?: string;
  /** Skip server certificate verification (default: false) */
  insecure?: boolean;
  /** ArgoCD sync wave annotation (default: '-1') */
  syncWave?: string;
}

/**
 * Creates the shared XRD and Composition for ArgoCD cluster credential sync.
 * Instantiate this once (typically in the Crossplane module).
 */
export class ArgoCdClusterSyncSetup extends Construct {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.xrd = this.createXrd();
    this.composition = this.createComposition();
  }

  private createXrd(): CompositeResourceDefinition {
    return new CompositeResourceDefinition(this, "xrd", {
      metadata: {
        name: "xargocdclustersyncs.nebula.io",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-10",
        },
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XArgoCdClusterSync",
          plural: "xargocdclustersyncs",
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
                      "clusterName",
                      "sourceSecretNamespace",
                      "sourceSecretName",
                      "sourceSecretKey",
                      "argoCdNamespace",
                      "argoCdSecretName",
                      "kubeProviderConfigName",
                    ],
                    properties: {
                      clusterName: {
                        type: "string",
                        description:
                          "Human-readable cluster name for ArgoCD UI",
                      },
                      apiServerUrl: {
                        type: "string",
                        description:
                          "Kubernetes API server URL for the target cluster",
                      },
                      sourceSecretNamespace: {
                        type: "string",
                        description:
                          "Namespace where the kubeconfig secret lives",
                      },
                      sourceSecretName: {
                        type: "string",
                        description: "Name of the kubeconfig secret",
                      },
                      sourceSecretKey: {
                        type: "string",
                        description:
                          "Key in the secret containing kubeconfig YAML",
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
                      insecure: {
                        type: "boolean",
                        description:
                          "Skip server certificate verification (default: false)",
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
    const secretTemplate = `
apiVersion: v1
kind: Secret
metadata:
  name: {{ .observed.composite.resource.spec.argoCdSecretName }}
  namespace: {{ .observed.composite.resource.spec.argoCdNamespace }}
  labels:
    argocd.argoproj.io/secret-type: cluster
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: argocd-cluster-secret
type: Opaque
{{- if .observed.resources }}
{{- $obj := index .observed.resources "kubeconfig-secret" }}
{{- if and $obj $obj.resource $obj.resource.status $obj.resource.status.atProvider $obj.resource.status.atProvider.manifest }}
{{- $secretData := $obj.resource.status.atProvider.manifest.data }}
{{- $kubeconfigB64 := index $secretData (.observed.composite.resource.spec.sourceSecretKey) }}
{{- $kubeconfigYaml := $kubeconfigB64 | b64dec }}
{{- $kc := $kubeconfigYaml | fromYaml }}
{{- $cluster := (index $kc.clusters 0).cluster }}
{{- $user := (index $kc.users 0).user }}
{{- $insecure := or .observed.composite.resource.spec.insecure false }}
{{- $serverUrl := "" }}
{{- if .observed.composite.resource.spec.apiServerUrl }}
  {{- $serverUrl = .observed.composite.resource.spec.apiServerUrl }}
{{- else }}
  {{- $serverUrl = $cluster.server }}
{{- end }}
stringData:
  name: {{ .observed.composite.resource.spec.clusterName }}
  server: {{ $serverUrl }}
  config: |
    {"tlsClientConfig":{"insecure":{{ $insecure }}{{- if not $insecure }},"caData":"{{ index $cluster "certificate-authority-data" }}"{{- end }},"certData":"{{ index $user "client-certificate-data" }}","keyData":"{{ index $user "client-key-data" }}"}}
{{- end }}
{{- end }}
`.trim();

    return new Composition(this, "composition", {
      metadata: {
        name: "argocd-cluster-sync",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-5",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XArgoCdClusterSync",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
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
                  name: "kubeconfig-secret",
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
                      fromFieldPath: "spec.sourceSecretName",
                      toFieldPath: "spec.forProvider.manifest.metadata.name",
                    },
                    {
                      type: "FromCompositeFieldPath",
                      fromFieldPath: "spec.sourceSecretNamespace",
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
}

/**
 * Creates an XR instance to sync a cluster's kubeconfig into an ArgoCD
 * cluster secret. Requires `ArgoCdClusterSyncSetup` to be installed.
 */
export class ArgoCdClusterSync extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: ArgoCdClusterSyncConfig) {
    super(scope, id);

    const argoCdNamespace = config.argoCdNamespace ?? "argocd";
    const argoCdSecretName = config.argoCdSecretName ?? config.clusterName;
    const kubeProviderConfigName =
      config.kubeProviderConfigName ?? "kubernetes-provider-config";
    const insecure = config.insecure ?? false;
    const syncWave = config.syncWave ?? "-1";

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XArgoCdClusterSync",
      metadata: {
        name: `${config.clusterName}-argocd-sync`,
        annotations: {
          "argocd.argoproj.io/sync-wave": syncWave,
        },
      },
      spec: {
        clusterName: config.clusterName,
        ...(config.apiServerUrl && { apiServerUrl: config.apiServerUrl }),
        sourceSecretNamespace: config.sourceSecretNamespace,
        sourceSecretName: config.sourceSecretName,
        sourceSecretKey: config.sourceSecretKey,
        argoCdNamespace,
        argoCdSecretName,
        kubeProviderConfigName,
        insecure,
      },
    });
  }
}
