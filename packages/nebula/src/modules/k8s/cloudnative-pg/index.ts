/**
 * CloudNativePg - PostgreSQL operator with GCS backup via Barman Cloud.
 *
 * This module has two deployment modes controlled by the `mode` config:
 *
 * - `"operator"` — Deploys the CNPG operator Helm chart and Barman Cloud Plugin.
 *   Target: the cluster where PostgreSQL instances will run (e.g. bare metal).
 *
 * - `"backup-infra"` — Creates GCS bucket, GCP Service Account + key via Crossplane,
 *   and pushes the SA key to a remote cluster via provider-kubernetes.
 *   Target: the management cluster where Crossplane runs (e.g. GKE).
 *
 * @example
 * ```typescript
 * // Bare metal chart — operator + plugin
 * new CloudNativePg(chart, 'cnpg', { mode: 'operator' });
 *
 * // GKE chart — Crossplane GCS backup infra + push secret to bare metal
 * new CloudNativePg(chart, 'cnpg', {
 *   mode: 'backup-infra',
 *   gcpProjectId: 'my-project',
 *   bucketName: 'my-cnpg-backups',
 *   remoteCluster: {
 *     kubeconfigSecret: { name: 'dev-cluster-kubeconfig', namespace: 'default', key: 'value' },
 *     targetNamespace: 'konductor',
 *     secretName: 'pg-backup-creds',
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm, Include, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import {
  ServiceAccount as CpServiceAccount,
  ServiceAccountKey as CpServiceAccountKey,
  ServiceAccountKeySpecDeletionPolicy,
  ServiceAccountSpecDeletionPolicy,
} from "#imports/cloudplatform.gcp.upbound.io";
import {
  BucketV1Beta2 as GcsBucket,
  BucketIamMemberV1Beta2 as BucketIamMember,
} from "#imports/storage.gcp.upbound.io";
import { BaseConstruct } from "../../../core";

/** Configuration for pushing backup credentials to a remote cluster */
export interface RemoteClusterConfig {
  /** Kubeconfig secret reference on the management cluster */
  kubeconfigSecret: {
    name: string;
    namespace: string;
    key: string;
  };
  /** Namespace on the remote cluster where the secret will be created */
  targetNamespace: string;
  /** Name of the secret to create on the remote cluster */
  secretName: string;
}

export interface CloudNativePgConfig {
  /**
   * Deployment mode:
   * - "operator" — CNPG operator Helm chart + Barman Cloud Plugin (bare metal)
   * - "backup-infra" — Crossplane GCS bucket + SA + key + push secret (GKE)
   */
  mode: "operator" | "backup-infra";
  /** Namespace (defaults to cnpg-system) */
  namespace?: string;
  /** CNPG Helm chart version (defaults to 0.27.1) */
  version?: string;
  /** Barman Cloud Plugin version (defaults to v0.11.0) */
  barmanCloudVersion?: string;
  /** Additional Helm values for the CNPG operator chart */
  values?: Record<string, unknown>;
  /** GCP project ID (required for backup-infra mode) */
  gcpProjectId?: string;
  /** GCS bucket name for backups (required for backup-infra mode) */
  bucketName?: string;
  /** Bucket lifecycle delete age in days (defaults to 90) */
  bucketRetentionDays?: number;
  /** ProviderConfig name for Crossplane GCP resources (defaults to "default") */
  providerConfigRef?: string;
  /** Configuration for pushing backup credentials to a remote cluster */
  remoteCluster?: RemoteClusterConfig;
}

export class CloudNativePg extends BaseConstruct<CloudNativePgConfig> {
  public readonly helm?: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly bucket?: GcsBucket;
  public readonly serviceAccount?: CpServiceAccount;
  public readonly serviceAccountEmail?: string;

  constructor(scope: Construct, id: string, config: CloudNativePgConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "cnpg-system";

    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    if (this.config.mode === "operator") {
      this.helm = new Helm(this, "cnpg-operator", {
        chart: "cloudnative-pg",
        releaseName: "cnpg",
        repo: "https://cloudnative-pg.github.io/charts",
        version: this.config.version ?? "0.27.1",
        namespace: namespaceName,
        values: this.config.values ?? {},
      });

      new Include(this, "barman-cloud-plugin", {
        url: `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${this.config.barmanCloudVersion ?? "v0.11.0"}/manifest.yaml`,
      });
    } else {
      if (!this.config.gcpProjectId || !this.config.bucketName) {
        throw new Error(
          "gcpProjectId and bucketName are required for backup-infra mode",
        );
      }

      const providerConfigRef = this.config.providerConfigRef ?? "default";
      const accountId = normalizeAccountId(`${id}-cnpg-backup`);
      this.serviceAccountEmail = `${accountId}@${this.config.gcpProjectId}.iam.gserviceaccount.com`;
      const connectionSecretName = `${id}-cnpg-backup-gcs-credentials`;

      // GCS Bucket for CNPG backups
      this.bucket = new GcsBucket(this, "backup-bucket", {
        metadata: {
          name: `${id}-cnpg-backup-bucket`,
          annotations: {
            "crossplane.io/external-name": this.config.bucketName,
          },
        },
        spec: {
          forProvider: {
            project: this.config.gcpProjectId,
            location: "EU",
            storageClass: "STANDARD",
            uniformBucketLevelAccess: true,
            forceDestroy: true,
            versioning: { enabled: false },
            lifecycleRule: [
              {
                action: { type: "Delete" },
                condition: { age: this.config.bucketRetentionDays ?? 90 },
              },
            ],
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // GCP Service Account
      this.serviceAccount = new CpServiceAccount(this, "backup-gsa", {
        metadata: {
          name: `${id}-cnpg-backup-gsa`,
          annotations: { "crossplane.io/external-name": accountId },
        },
        spec: {
          forProvider: {
            displayName: `CNPG Backup SA for ${id}`,
            project: this.config.gcpProjectId,
          },
          providerConfigRef: { name: providerConfigRef },
          deletionPolicy: ServiceAccountSpecDeletionPolicy.DELETE,
        },
      });

      // Grant Storage Object Admin on the bucket
      new BucketIamMember(this, "backup-bucket-iam", {
        metadata: { name: `${id}-cnpg-backup-bucket-iam` },
        spec: {
          forProvider: {
            bucket: this.config.bucketName,
            role: "roles/storage.objectAdmin",
            member: `serviceAccount:${this.serviceAccountEmail}`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // Barman-cloud requires storage.buckets.get to verify bucket existence
      new BucketIamMember(this, "backup-bucket-reader-iam", {
        metadata: { name: `${id}-cnpg-backup-bucket-reader` },
        spec: {
          forProvider: {
            bucket: this.config.bucketName,
            role: "roles/storage.legacyBucketReader",
            member: `serviceAccount:${this.serviceAccountEmail}`,
          },
          providerConfigRef: { name: providerConfigRef },
        },
      });

      // SA key — Crossplane writes the JSON key to a K8s Secret
      new CpServiceAccountKey(this, "backup-gsa-key", {
        metadata: { name: `${id}-cnpg-backup-gsa-key` },
        spec: {
          forProvider: {
            serviceAccountIdRef: { name: `${id}-cnpg-backup-gsa` },
          },
          providerConfigRef: { name: providerConfigRef },
          deletionPolicy: ServiceAccountKeySpecDeletionPolicy.DELETE,
          writeConnectionSecretToRef: {
            name: connectionSecretName,
            namespace: namespaceName,
          },
        },
      });

      // Push secret to remote cluster
      if (this.config.remoteCluster) {
        const remote = this.config.remoteCluster;
        const providerConfigName = `${id}-bare-metal-cluster`;

        new ApiObject(this, "remote-provider-config", {
          apiVersion: "kubernetes.crossplane.io/v1alpha1",
          kind: "ProviderConfig",
          metadata: { name: providerConfigName },
          spec: {
            credentials: {
              source: "Secret",
              secretRef: remote.kubeconfigSecret,
            },
          },
        });

        new ApiObject(this, "remote-backup-secret", {
          apiVersion: "kubernetes.crossplane.io/v1alpha2",
          kind: "Object",
          metadata: { name: `${id}-cnpg-backup-remote-secret` },
          spec: {
            providerConfigRef: { name: providerConfigName },
            forProvider: {
              manifest: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: {
                  name: remote.secretName,
                  namespace: remote.targetNamespace,
                },
                data: {
                  gcsCredentials: "",
                },
              },
            },
            references: [
              {
                patchesFrom: {
                  apiVersion: "v1",
                  kind: "Secret",
                  name: connectionSecretName,
                  namespace: namespaceName,
                  fieldPath: "data.private_key",
                },
                toFieldPath: "data.gcsCredentials",
              },
            ],
          },
        });
      }
    }
  }
}

function normalizeAccountId(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `a-${s}`;
  if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
  if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
  return s;
}
