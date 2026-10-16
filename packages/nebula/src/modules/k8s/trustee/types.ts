import type { TrusteeSnpIdentity } from "./policies";

export interface TrusteeNetworkConfig {
  /** Anchored patterns for addresses assigned by the approved CNI. Loopback,
   * mapped loopback and unspecified addresses are independently forbidden. */
  readonly ipv4AddressPattern: string;
  readonly ipv6AddressPattern: string;
}

/** Public inputs. Secrets are provisioned over attested TLS after startup. */
export interface TrusteeConfig {
  readonly name: string;
  readonly namespace: string;
  /** Unmodified upstream KBS with built-in AS/RVPS, pinned by digest. */
  readonly kbsImage: string;
  /** Unmodified upstream TNG with coco_asr, pinned by digest. */
  readonly tngImage: string;
  readonly ownerPublicKeyPem: string;
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly clients: readonly { readonly namespace: string; readonly podLabels: Readonly<Record<string, string>> }[];
  readonly network: TrusteeNetworkConfig;
  /** Native genpolicy wire settings. Defaults match Nebula's k0s/containerd 2.3 runtime. */
  readonly k8sDistribution?: "k0s" | "kubernetes";
  readonly ociVersion?: "1.1.0" | "1.2.0" | "1.3.0";
  /** Owner-approved SNP guest identity. The module generates the workload hash;
   * it must never be learned from the untrusted deployed endpoint. */
  readonly guest: Omit<TrusteeSnpIdentity, "initDataSha256">;
  readonly genpolicy?: {
    /** Native genpolicy installation. Defaults to genpolicy on PATH. */
    readonly executable?: string;
    /** Trusted owner-local image cache, never a source of policy or identity. */
    readonly cacheDirectory?: string;
  };
  readonly createNamespace?: boolean;
}

export type TngTrusteeConfig = TrusteeConfig;

export interface TrusteeTngConfig {
  readonly add_egress: readonly {
    readonly mapping: {
      readonly in: { readonly host: string; readonly port: number };
      readonly out: { readonly host: string; readonly port: number };
    };
    readonly attest: { readonly aa_provider: "coco_asr"; readonly asr_addr: string; readonly refresh_interval: number };
    readonly rats_tls: { readonly multiplex: false };
  }[];
}
