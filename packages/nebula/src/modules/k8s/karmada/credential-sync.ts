/**
 * Karmada Cluster Credential Sync via Crossplane Composition.
 *
 * Bridges credentials from a member cluster into Karmada's etcd by:
 * 1. Observing a ServiceAccount token Secret on the member cluster
 *    (via a remote ProviderConfig, e.g. cnpg-bare-metal-cluster)
 * 2. Extracting `ca.crt` and `token` using function-go-templating
 * 3. Writing a Secret (caBundle + token) into Karmada's etcd
 *    via a ProviderConfig targeting the Karmada API server
 *
 * Split into two parts:
 * - `KarmadaCredentialSyncSetup` — creates the shared XRD + Composition (once)
 * - `KarmadaCredentialSync` — creates an XR instance (per cluster)
 *
 * Prerequisites:
 * - Crossplane with provider-kubernetes, function-patch-and-transform,
 *   and function-go-templating installed
 * - A ProviderConfig for the member cluster (e.g. cnpg-bare-metal-cluster)
 * - A ProviderConfig for the Karmada API server (e.g. karmada-api)
 * - A kubernetes.io/service-account-token Secret on the member cluster
 *
 * @example
 * ```typescript
 * // In crossplane module (once):
 * new KarmadaCredentialSyncSetup(this, 'karmada-credential-sync-setup');
 *
 * // Per cluster:
 * new KarmadaCredentialSync(chart, 'dev-cluster-karmada-sync', {
 *   clusterName: 'dev-cluster',
 *   sourceProviderConfigName: 'cnpg-bare-metal-cluster',
 *   sourceSecretNamespace: 'karmada-system',
 *   sourceSecretName: 'karmada-agent-token',
 *   karmadaProviderConfigName: 'karmada-api',
 *   targetSecretName: 'dev-cluster-kubeconfig',
 *   targetSecretNamespace: 'karmada-system',
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";

export interface KarmadaCredentialSyncConfig {
  /** Human-readable cluster name */
  clusterName: string;
  /** ProviderConfig name for the member cluster (source of the SA token) */
  sourceProviderConfigName: string;
  /** Namespace of the SA token secret on the member cluster */
  sourceSecretNamespace: string;
  /** Name of the SA token secret on the member cluster */
  sourceSecretName: string;
  /** ProviderConfig name for the Karmada API server */
  karmadaProviderConfigName: string;
  /** Name of the secret to create in Karmada's etcd */
  targetSecretName: string;
  /** Namespace for the secret in Karmada's etcd (default: karmada-system) */
  targetSecretNamespace?: string;
  /** ArgoCD sync wave annotation (default: '5') */
  syncWave?: string;
}

/**
 * Creates the shared XRD and Composition for Karmada cluster credential sync.
 * Instantiate this once (typically in the Crossplane module).
 */
export class KarmadaCredentialSyncSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.xrd = this.createXrd();
    this.composition = this.createComposition();
  }

  private createXrd(): CompositeResourceDefinitionV2 {
    return new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xkarmadacredentialsyncs.nebula.io",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-10",
        },
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XKarmadaCredentialSync",
          plural: "xkarmadacredentialsyncs",
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
                      "clusterName",
                      "sourceProviderConfigName",
                      "sourceSecretNamespace",
                      "sourceSecretName",
                      "karmadaProviderConfigName",
                      "targetSecretName",
                      "targetSecretNamespace",
                    ],
                    properties: {
                      clusterName: {
                        type: "string",
                        description: "Human-readable cluster name",
                      },
                      sourceProviderConfigName: {
                        type: "string",
                        description:
                          "ProviderConfig name for the member cluster",
                      },
                      sourceSecretNamespace: {
                        type: "string",
                        description:
                          "Namespace of the SA token secret on the member cluster",
                      },
                      sourceSecretName: {
                        type: "string",
                        description:
                          "Name of the SA token secret on the member cluster",
                      },
                      karmadaProviderConfigName: {
                        type: "string",
                        description:
                          "ProviderConfig name for the Karmada API server",
                      },
                      targetSecretName: {
                        type: "string",
                        description:
                          "Name of the secret to create in Karmada etcd",
                      },
                      targetSecretNamespace: {
                        type: "string",
                        description:
                          "Namespace for the secret in Karmada etcd",
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
    // The go-templating step reads the observed SA token secret from the
    // member cluster and renders a Crossplane Object targeting Karmada API.
    // The Object wraps a Secret with caBundle + token that Karmada expects.
    const secretTemplate = `
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ .observed.composite.resource.spec.clusterName }}-karmada-cred
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: karmada-credential-secret
spec:
  providerConfigRef:
    name: {{ .observed.composite.resource.spec.karmadaProviderConfigName }}
  forProvider:
    manifest:
      apiVersion: v1
      kind: Secret
      metadata:
        name: {{ .observed.composite.resource.spec.targetSecretName }}
        namespace: {{ .observed.composite.resource.spec.targetSecretNamespace }}
      type: Opaque
      {{- if .observed.resources }}
      {{- $obj := index .observed.resources "sa-token-secret" }}
      {{- if and $obj $obj.resource $obj.resource.status $obj.resource.status.atProvider $obj.resource.status.atProvider.manifest }}
      {{- $secretData := $obj.resource.status.atProvider.manifest.data }}
      data:
        caBundle: {{ index $secretData "ca.crt" }}
        token: {{ index $secretData "token" }}
      {{- end }}
      {{- end }}
`.trim();

    return new Composition(this, "composition", {
      metadata: {
        name: "karmada-credential-sync",
        annotations: {
          "argocd.argoproj.io/sync-wave": "-5",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XKarmadaCredentialSync",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "observe-sa-token",
            functionRef: {
              name: "function-patch-and-transform",
            },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                {
                  name: "sa-token-secret",
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
                      fromFieldPath: "spec.sourceProviderConfigName",
                      toFieldPath: "spec.providerConfigRef.name",
                    },
                  ],
                },
              ],
            },
          },
          {
            step: "render-karmada-secret",
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
 * Creates an XR instance to sync a member cluster's SA token into a
 * Karmada credential secret. Requires `KarmadaCredentialSyncSetup` to be installed.
 */
export class KarmadaCredentialSync extends Construct {
  public readonly xr: ApiObject;

  constructor(
    scope: Construct,
    id: string,
    config: KarmadaCredentialSyncConfig,
  ) {
    super(scope, id);

    const targetSecretNamespace =
      config.targetSecretNamespace ?? "karmada-system";
    const syncWave = config.syncWave ?? "5";

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XKarmadaCredentialSync",
      metadata: {
        name: `${config.clusterName}-karmada-cred-sync`,
        annotations: {
          "argocd.argoproj.io/sync-wave": syncWave,
        },
      },
      spec: {
        clusterName: config.clusterName,
        sourceProviderConfigName: config.sourceProviderConfigName,
        sourceSecretNamespace: config.sourceSecretNamespace,
        sourceSecretName: config.sourceSecretName,
        karmadaProviderConfigName: config.karmadaProviderConfigName,
        targetSecretName: config.targetSecretName,
        targetSecretNamespace,
      },
    });
  }
}
