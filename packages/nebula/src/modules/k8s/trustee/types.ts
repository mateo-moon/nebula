import type { MeasuredArtifact } from "../confidential-guests/measured";
import type { KbsResourcePath } from "../confidential-guests/pull-broker";
import type { TrusteeDeploymentManifest, TrusteePodManifest } from "./manifests";
import type { TrusteePolicies, TrusteeResourceAdmission } from "./policies";

export interface TrusteeResource extends TrusteeResourceAdmission {
  /** Versioned resource on the independent bootstrap KBS; contains the bytes to serve. */
  readonly bootstrapPath: KbsResourcePath;
}

export interface TrusteeConfig {
  readonly name: string;
  readonly namespace: string;
  /** Upstream KBS with built-in AS, curl, openssl and coreutils, pinned by digest.
   * The config/storage contract is Trustee revision 71251310045d8be2e95041cf0028691623c73957.
   * A release tag alone does not establish this contract. */
  readonly image: string;
  readonly bootstrap: {
    /** Independently governed root of trust; never this unprovisioned Trustee. */
    readonly url: string;
    /** Public HTTPS trust anchor, embedded in measured AA and CDH configuration.
     * Upstream adds this to its roots. The approved guest must exclude other
     * roots that could authenticate an administrator-controlled impostor. */
    readonly certificatePem: string;
    readonly tlsPrivateKey: KbsResourcePath;
    readonly tlsCertificate: KbsResourcePath;
  };
  readonly resources: readonly TrusteeResource[];
  readonly nodeSelector: Readonly<Record<string, string>>;
  /** NetworkPolicy is defense in depth; the attested policies enforce identity. */
  readonly clients: readonly { readonly namespace: string; readonly podLabels: Readonly<Record<string, string>> }[];
  readonly port?: number;
  /** Public DNS name in the bootstrapped TLS certificate. Defaults to Service FQDN. */
  readonly endpointHost?: string;
  readonly createNamespace?: boolean;
  /** Kata base-memory annotation; effective VM memory also depends on runtime resource accounting. */
  readonly guestMemoryMiB?: number;
  /** Kata base-vCPU annotation; some runtimes add container CPU limits at launch. */
  readonly guestVcpus?: number;
}

export interface TrusteePlan extends TrusteePolicies {
  /** Exact unsigned Deployment to feed to genpolicy (preserves generated-name rules). */
  readonly workload: TrusteeDeploymentManifest;
  /** Canonical Pod-shaped template used for the measured-artifact hash. */
  readonly pod: TrusteePodManifest;
  readonly canonicalPodSha256: string;
  readonly configToml: string;
  readonly aaToml: string;
  readonly cdhToml: string;
  readonly serviceUrl: string;
}

/** Self-sufficient, ephemeral Trustee. Only the owner's PUBLIC administration
 * key enters the manifest. Both server images must be public and digest pinned. */
export interface TngTrusteeConfig {
  readonly name: string;
  readonly namespace: string;
  readonly kbsImage: string;
  readonly tngImage: string;
  readonly ownerPublicKeyPem: string;
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly clients: readonly { readonly namespace: string; readonly podLabels: Readonly<Record<string, string>> }[];
  readonly createNamespace?: boolean;
}

/** The deployment owner supplies a reviewed, tested Kata policy for this exact
 * Pod. Hash binding prevents stale artifacts, not semantically unsafe Rego. */
export interface TrusteeAgentPolicy {
  readonly canonicalPodSha256: string;
  readonly policyRego: string;
}

/** Inputs for deployment after offline policy generation and review. */
export interface TrusteeDeploymentConfig extends TrusteeConfig {
  readonly policy: MeasuredArtifact;
}

export interface TngTrusteeDeploymentConfig extends TngTrusteeConfig {
  readonly policy: MeasuredArtifact;
}

export interface TngTrusteePlan {
  readonly pod: TrusteePodManifest;
  readonly workload: TrusteeDeploymentManifest;
  readonly canonicalPodSha256: string;
  readonly kbsConfig: string;
  readonly aaToml: string;
  readonly tngConfig: {
    readonly add_egress: readonly {
      readonly mapping: {
        readonly in: { readonly host: string; readonly port: number };
        readonly out: { readonly host: string; readonly port: number };
      };
      readonly attest: { readonly aa_provider: "coco_asr"; readonly asr_addr: string; readonly refresh_interval: number };
      readonly rats_tls: { readonly multiplex: false };
    }[];
  };
}
