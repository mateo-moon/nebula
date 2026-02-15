/**
 * Longhorn - Distributed block storage with LUKS encryption and backup support.
 *
 * Deploys the Longhorn Helm chart with an encrypted StorageClass backed by
 * LUKS and optional backup to a GCS bucket via S3-compatible HMAC credentials.
 *
 * @example
 * ```typescript
 * import { Longhorn } from 'nebula/modules/k8s/longhorn';
 *
 * new Longhorn(chart, 'longhorn', {
 *   encryption: {
 *     cryptoKey: 'ref+sops://secrets.yaml#longhorn/crypto_key',
 *   },
 *   backup: {
 *     target: 's3://my-bucket@us/',
 *     hmacAccessKey: 'ref+sops://secrets.yaml#longhorn/gcs_hmac_access_key',
 *     hmacSecret: 'ref+sops://secrets.yaml#longhorn/gcs_hmac_secret',
 *     s3Endpoint: 'https://storage.googleapis.com',
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { KubeStorageClass } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";

/** LUKS encryption configuration */
export interface LonghornEncryptionConfig {
  /** LUKS encryption key */
  cryptoKey: string;
  /** Cipher algorithm (defaults to aes-xts-plain64) */
  cipher?: string;
  /** Hash algorithm (defaults to sha256) */
  hash?: string;
  /** Key size in bits (defaults to 256) */
  keySize?: string;
  /** PBKDF algorithm (defaults to argon2i) */
  pbkdf?: string;
}

/** S3-compatible backup configuration */
export interface LonghornBackupConfig {
  /** Backup target URL (e.g. s3://bucket-name@region/) */
  target: string;
  /** S3/HMAC access key */
  hmacAccessKey: string;
  /** S3/HMAC secret key */
  hmacSecret: string;
  /** S3-compatible endpoint (defaults to https://storage.googleapis.com) */
  s3Endpoint?: string;
  /** Daily backup cron schedule (defaults to "0 2 * * *") */
  schedule?: string;
  /** Number of backups to retain (defaults to 7) */
  retain?: number;
}

export interface LonghornConfig {
  /** Namespace (defaults to longhorn-system) */
  namespace?: string;
  /** Helm chart version (defaults to 1.11.0) */
  version?: string;
  /** Default data path on nodes (defaults to /data/longhorn) */
  defaultDataPath?: string;
  /** Default replica count (defaults to 1) */
  defaultReplicaCount?: number;
  /** Additional Helm values */
  values?: Record<string, unknown>;
  /** LUKS encryption configuration for the encrypted StorageClass */
  encryption?: LonghornEncryptionConfig;
  /** S3-compatible backup configuration */
  backup?: LonghornBackupConfig;
  /** Encrypted StorageClass name (defaults to longhorn-encrypted) */
  storageClassName?: string;
  /** StorageClass reclaim policy (defaults to Retain) */
  reclaimPolicy?: string;
  /** Data locality (defaults to strict-local) */
  dataLocality?: string;
}

export class Longhorn extends BaseConstruct<LonghornConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly storageClassName: string;

  constructor(scope: Construct, id: string, config: LonghornConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "longhorn-system";
    this.storageClassName = this.config.storageClassName ?? "longhorn-encrypted";

    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // --- Encryption secret ---

    if (this.config.encryption) {
      const enc = this.config.encryption;
      new kplus.Secret(this, "crypto-secret", {
        metadata: { name: "longhorn-crypto", namespace: namespaceName },
        stringData: {
          CRYPTO_KEY_VALUE: enc.cryptoKey,
          CRYPTO_KEY_PROVIDER: "secret",
          CRYPTO_KEY_CIPHER: enc.cipher ?? "aes-xts-plain64",
          CRYPTO_KEY_HASH: enc.hash ?? "sha256",
          CRYPTO_KEY_SIZE: enc.keySize ?? "256",
          CRYPTO_PBKDF: enc.pbkdf ?? "argon2i",
        },
      });
    }

    // --- Backup credentials ---

    if (this.config.backup) {
      const bk = this.config.backup;
      new kplus.Secret(this, "backup-secret", {
        metadata: { name: "longhorn-gcs-backups", namespace: namespaceName },
        stringData: {
          AWS_ACCESS_KEY_ID: bk.hmacAccessKey,
          AWS_SECRET_ACCESS_KEY: bk.hmacSecret,
          AWS_ENDPOINTS: bk.s3Endpoint ?? "https://storage.googleapis.com",
        },
      });
    }

    // --- Helm chart ---

    const helmValues: Record<string, unknown> = {
      image: {
        longhorn: {
          instanceManager: {
            tag: `v${this.config.version ?? "1.11.0"}-hotfix-1`,
          },
        },
      },
      defaultSettings: {
        defaultDataPath: this.config.defaultDataPath ?? "/data/longhorn",
        defaultReplicaCount: this.config.defaultReplicaCount ?? 1,
        ...(this.config.backup
          ? {
              backupTarget: this.config.backup.target,
              backupTargetCredentialSecret: "longhorn-gcs-backups",
            }
          : {}),
      },
      ...this.config.values,
    };

    this.helm = new Helm(this, "helm", {
      chart: "longhorn",
      releaseName: "longhorn",
      repo: "https://charts.longhorn.io",
      version: this.config.version ?? "1.11.0",
      namespace: namespaceName,
      values: helmValues,
    });

    // --- Encrypted StorageClass ---

    if (this.config.encryption) {
      new KubeStorageClass(this, "storage-class", {
        metadata: { name: this.storageClassName },
        provisioner: "driver.longhorn.io",
        allowVolumeExpansion: true,
        reclaimPolicy: this.config.reclaimPolicy ?? "Retain",
        volumeBindingMode: "Immediate",
        parameters: {
          numberOfReplicas: String(this.config.defaultReplicaCount ?? 1),
          dataLocality: this.config.dataLocality ?? "strict-local",
          encrypted: "true",
          "csi.storage.k8s.io/provisioner-secret-name": "longhorn-crypto",
          "csi.storage.k8s.io/provisioner-secret-namespace": namespaceName,
          "csi.storage.k8s.io/node-publish-secret-name": "longhorn-crypto",
          "csi.storage.k8s.io/node-publish-secret-namespace": namespaceName,
          "csi.storage.k8s.io/node-stage-secret-name": "longhorn-crypto",
          "csi.storage.k8s.io/node-stage-secret-namespace": namespaceName,
          "csi.storage.k8s.io/node-expand-secret-name": "longhorn-crypto",
          "csi.storage.k8s.io/node-expand-secret-namespace": namespaceName,
        },
      });
    }

    // --- Daily backup recurring job ---

    if (this.config.backup) {
      new ApiObject(this, "daily-backup", {
        apiVersion: "longhorn.io/v1beta2",
        kind: "RecurringJob",
        metadata: { name: "daily-backup", namespace: namespaceName },
        spec: {
          cron: this.config.backup.schedule ?? "0 2 * * *",
          task: "backup",
          retain: this.config.backup.retain ?? 7,
          concurrency: 1,
          groups: ["default"],
        },
      });
    }
  }
}
