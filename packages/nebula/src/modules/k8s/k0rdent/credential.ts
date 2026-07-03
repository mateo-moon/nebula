/**
 * Credential — a k0rdent `Credential` a ClusterDeployment references, wrapping a
 * CAPI AWS ClusterIdentity. Two modes:
 *
 *  - "keyless" (default): reference the cluster-scoped
 *    `AWSClusterControllerIdentity/default` — CAPA authenticates to AWS via the
 *    management cluster's node INSTANCE PROFILE (IMDS). No AWS keys stored.
 *    Parity with nebula's keyless CAPA today; requires a keyless management
 *    cluster (IMDS hop-2 + controller policy on the node role).
 *  - "static": create an `AWSClusterStaticIdentity` + a Secret holding
 *    AccessKeyID/SecretAccessKey (from `ref+sops://` values), both labeled
 *    `k0rdent.mirantis.com/component: kcm` so KCM's controllers pick them up.
 *
 * Objects live in `kcm-system` (where KCM + CAPA run on the management cluster).
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { BaseConstruct } from "../../../core";
import { Credential as CredentialCr } from "#imports/k0rdent.mirantis.com";
import { AwsClusterStaticIdentityV1Beta2 } from "#imports/infrastructure.cluster.x-k8s.io";

const KCM_COMPONENT_LABEL = { "k0rdent.mirantis.com/component": "kcm" };
const AWS_IDENTITY_API_VERSION = "infrastructure.cluster.x-k8s.io/v1beta2";

export interface CredentialConfig {
  /** Credential CR name (default "aws-cluster-identity-cred"). */
  name?: string;
  /** Namespace (default "kcm-system"). */
  namespace?: string;
  /** Human description on the Credential. */
  description?: string;
  /**
   * "keyless" (default) → reference AWSClusterControllerIdentity (node instance
   * profile). "static" → create an AWSClusterStaticIdentity + Secret.
   */
  mode?: "keyless" | "static";
  /** keyless: the AWSClusterControllerIdentity name (default "default"). */
  controllerIdentityName?: string;
  /** static: AWSClusterStaticIdentity name (default "aws-cluster-identity"). */
  identityName?: string;
  /** static: Secret name holding the keys (default "aws-cluster-identity-secret"). */
  secretName?: string;
  /** static: AWS access key id. Supports `ref+sops://…` (resolved at synth). */
  accessKeyId?: string;
  /** static: AWS secret access key. Supports `ref+sops://…`. */
  secretAccessKey?: string;
  /** static: optional AWS session token (STS). Supports `ref+sops://…`. */
  sessionToken?: string;
}

export class Credential extends BaseConstruct<CredentialConfig> {
  public readonly cr: CredentialCr;
  public readonly identity?: AwsClusterStaticIdentityV1Beta2;
  public readonly secret?: ApiObject;
  /** The Credential name — reference this from `ClusterDeployment.spec.credential`. */
  public readonly credentialName: string;

  constructor(scope: Construct, id: string, config: CredentialConfig = {}) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kcm-system";
    this.credentialName = this.config.name ?? "aws-cluster-identity-cred";
    const mode = this.config.mode ?? "keyless";

    let identityKind: string;
    let identityName: string;

    if (mode === "static") {
      identityKind = "AWSClusterStaticIdentity";
      identityName = this.config.identityName ?? "aws-cluster-identity";
      const secretName = this.config.secretName ?? "aws-cluster-identity-secret";

      this.secret = new ApiObject(this, "identity-secret", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: secretName, namespace, labels: KCM_COMPONENT_LABEL },
        type: "Opaque",
        stringData: {
          ...(this.config.accessKeyId ? { AccessKeyID: this.config.accessKeyId } : {}),
          ...(this.config.secretAccessKey
            ? { SecretAccessKey: this.config.secretAccessKey }
            : {}),
          ...(this.config.sessionToken
            ? { SessionToken: this.config.sessionToken }
            : {}),
        },
      });

      this.identity = new AwsClusterStaticIdentityV1Beta2(this, "identity", {
        metadata: { name: identityName, namespace, labels: KCM_COMPONENT_LABEL },
        spec: { secretRef: secretName, allowedNamespaces: {} },
      });
    } else {
      // keyless — reference CAPA's controller identity (instance profile). It is
      // cluster-scoped and created by CAPA; we only reference it.
      identityKind = "AWSClusterControllerIdentity";
      identityName = this.config.controllerIdentityName ?? "default";
    }

    this.cr = new CredentialCr(this, "credential", {
      metadata: { name: this.credentialName, namespace },
      spec: {
        ...(this.config.description ? { description: this.config.description } : {}),
        identityRef: {
          apiVersion: AWS_IDENTITY_API_VERSION,
          kind: identityKind,
          name: identityName,
        },
      },
    });
  }
}
