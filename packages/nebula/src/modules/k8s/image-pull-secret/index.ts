/**
 * ImagePullSecret — registry pull credentials fanned out across namespaces.
 *
 * Renders a `kubernetes.io/dockerconfigjson` Secret in every listed namespace
 * (optionally creating the namespaces), built from a registry service-account
 * key JSON — the GCR/Artifact-Registry JSON-key scheme: username `_json_key`,
 * password = the raw SA key JSON. The kubelet accepts the `auth` field;
 * username/password are kept for tooling parity.
 *
 * `saJsonRef` accepts a `ref+sops://...` (or any vals ref+) string — it is
 * resolved at synth time via the standard secret resolution ({@link BaseConstruct}).
 * Resolution is strict: a missing sops key fails the synth instead of shipping
 * a literal `ref+` string that would surface as inscrutable ImagePullBackoffs.
 *
 * @example
 * ```typescript
 * import { ImagePullSecret } from 'nebula/modules/k8s/image-pull-secret';
 *
 * new ImagePullSecret(chart, 'gcr-pull-secret', {
 *   registry: 'gcr.io',
 *   saJsonRef: 'ref+sops://.secrets/secrets.yaml#gcr/pull-sa-json',
 *   namespaces: ['tool-node', 'tool-node-2'],
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { BaseConstruct } from "../../../core";

export interface ImagePullSecretConfig {
  /** Registry host the credentials authenticate against (e.g. gcr.io) */
  registry: string;
  /**
   * Registry service-account key JSON — pass a `ref+sops://...` reference
   * (resolved at synth time) or the literal JSON.
   */
  saJsonRef: string;
  /** Name of the dockerconfigjson Secret created in each namespace (defaults to gcr-json-key) */
  secretName?: string;
  /** Namespaces to render the Secret into */
  namespaces: string[];
  /**
   * Create the Namespace objects too. Pass false when the namespaces are
   * owned elsewhere and only the Secrets should be rendered.
   * @default true
   */
  createNamespaces?: boolean;
}

export class ImagePullSecret extends BaseConstruct<ImagePullSecretConfig> {
  public readonly namespaces: ApiObject[] = [];
  public readonly secrets: ApiObject[] = [];

  /** The rendered .dockerconfigjson payload */
  public readonly dockerConfigJson: string;

  constructor(scope: Construct, id: string, config: ImagePullSecretConfig) {
    super(scope, id, config);

    // this.config.saJsonRef is already resolved (BaseConstruct resolves ref+
    // patterns). Build the JSON-key dockerconfig: username `_json_key`,
    // password = the raw SA JSON (the kubelet uses the `auth` field).
    const saJson = this.config.saJsonRef;
    this.dockerConfigJson = JSON.stringify({
      auths: {
        [this.config.registry]: {
          username: "_json_key",
          password: saJson,
          auth: Buffer.from(`_json_key:${saJson}`).toString("base64"),
        },
      },
    });

    const secretName = this.config.secretName ?? "gcr-json-key";

    for (const ns of this.config.namespaces) {
      if (this.config.createNamespaces !== false) {
        this.namespaces.push(
          new ApiObject(this, `ns-${ns}`, {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: ns },
          }),
        );
      }
      this.secrets.push(
        new ApiObject(this, `${secretName}-${ns}`, {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: secretName, namespace: ns },
          type: "kubernetes.io/dockerconfigjson",
          stringData: { ".dockerconfigjson": this.dockerConfigJson },
        }),
      );
    }
  }
}
