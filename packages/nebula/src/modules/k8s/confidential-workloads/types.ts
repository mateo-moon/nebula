import type { TrusteeConfig, TrusteeNetworkConfig } from "../trustee/types";
import type { TrusteeResourcePath, TrusteeSnpIdentity } from "../trustee/policies";

export const CONFIDENTIAL_API = "confidential.nebula.dev/v1alpha1";
export const CONFIDENTIAL_GROUP = "confidential.nebula.dev";

export interface ResourceMetadata {
  name: string;
  namespace: string;
  uid?: string;
  generation?: number;
  resourceVersion?: string;
}

/** Public declaration. A block claim holds ciphertext, never a key. */
export type ConfidentialStorageSpec =
  | { type: "Memory"; sizeLimit: string }
  | {
    type: "EncryptedBlock";
    claimName: string;
    sizeBytes: number;
    keyResource: TrusteeResourcePath;
    /** Only an entirely zero, explicitly declared disk may be initialized. */
    initialization: "Never" | "IfEmpty";
    retention: "Retain";
  };

export interface ConfidentialStorageResource {
  apiVersion: typeof CONFIDENTIAL_API;
  kind: "ConfidentialStorage";
  metadata: ResourceMetadata;
  spec: ConfidentialStorageSpec;
}

export interface WorkloadContainer {
  name: string;
  /** An immutable digest, or a reserved release tag that the operator resolves
   * only after the owner publishes its encrypted OCI manifest. */
  image: string;
  /** CoCo key ID for an owner-published encrypted image. Required with a tag. */
  imageKeyResource?: TrusteeResourcePath;
  command?: readonly string[];
  /** Derive Entrypoint + Cmd from the published, digest-bound OCI config. */
  commandFromImage?: true;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  uid: number;
  gid: number;
  mounts?: readonly { storage: string; path: string }[];
  /** Explicit resources exposed through this container's private Unix socket.
   * Encrypted volume keys may never appear here. */
  applicationResources?: readonly TrusteeResourcePath[];
  ports?: readonly { name: string; port: number }[];
  resources?: {
    requests: Readonly<Record<string, string>>;
    limits: Readonly<Record<string, string>>;
  };
}

export interface ConfidentialWorkloadSpec {
  /** Security profile/audience shared by identical deployments. Resource names,
   * Pod UIDs and claim names are routing metadata, never instance credentials. */
  profile: string;
  /** Legacy pre-enrolled public key. New stacks use ownerClaimSha256 instead. */
  ownerPublicKeyPem?: string;
  /** SHA-256 of the administrator-issued, one-use claim token. The first
   * attested claimant installs their own P-256 key. A stolen token can deny
   * enrollment but cannot access keys that the owner has not provisioned. */
  ownerClaimSha256?: string;
  /** Generate first-access credentials at reconciliation, outside deterministic
   * synthesis. The Secret holds bootstrap authority only, never workload keys. */
  accessLink?: {
    url: string;
    secretName: string;
    ownerPort: number;
    /** Public AMD endorsement in PEM; native AS still validates the chain. */
    vcekCertificate?: string;
  };
  guest: Omit<TrusteeSnpIdentity, "initDataSha256">;
  nodeSelector: Readonly<Record<string, string>>;
  network: TrusteeNetworkConfig;
  trustee: Pick<TrusteeConfig, "chart" | "repository" | "version" | "kbsImage" | "tngImage"> & {
    gatewayImage: string;
  };
  storageImage: string;
  containers: readonly WorkloadContainer[];
  storage?: readonly { name: string; resource: string }[];
  /** Image keys and other resources this VM may consume locally. */
  resources: readonly TrusteeResourcePath[];
  /** Public registry routing only. Credentials cannot be embedded in this API. */
  registryMirrors?: readonly { prefix: string; location: string; insecure: boolean }[];
  /** Kata base resources. With static resource management, workload resource
   * limits are added at launch; approve the resulting total vCPU measurement. */
  runtime?: { memoryMiB?: number; vcpus?: number; k8sDistribution?: "k0s" | "kubernetes"; ociVersion?: "1.1.0" | "1.2.0" | "1.3.0" };
}

export interface ConfidentialWorkloadResource {
  apiVersion: typeof CONFIDENTIAL_API;
  kind: "ConfidentialWorkload";
  metadata: ResourceMetadata;
  spec: ConfidentialWorkloadSpec;
}

export interface WorkloadRenderOptions {
  /** Operator installation/owner tool setting, never executable code from a CR. */
  genpolicy?: TrusteeConfig["genpolicy"];
  /** Owner-side digest from the verified encrypted publication. The operator
   * resolves the same tag independently before constructing its Pod. */
  publishedImageDigests?: Readonly<Record<string, string>>;
  /** Owner publisher's verified OCI metadata; the operator resolves its own. */
  publishedImageConfigs?: Readonly<Record<string, { manifest: Uint8Array; config: Uint8Array }>>;
}
