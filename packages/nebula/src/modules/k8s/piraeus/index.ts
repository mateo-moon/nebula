/**
 * Piraeus - LINSTOR/DRBD distributed block storage with LUKS encryption.
 *
 * Deploys the Piraeus Operator and LINSTOR cluster with configurable storage
 * pools, LUKS encryption, and DRBD Protocol A for async cross-site replication.
 *
 * @example
 * ```typescript
 * import { Piraeus } from 'nebula/modules/k8s/piraeus';
 *
 * new Piraeus(chart, 'piraeus', {
 *   encryption: { passphrase: 'ref+sops://secrets.yaml#piraeus/passphrase' },
 *   storagePool: { type: 'lvmThin', hostDevices: ['/dev/sdb'] },
 *   replication: { crossSiteAsync: true },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Include, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { KubeStorageClass } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";

/** LUKS encryption configuration */
export interface PiraeusEncryptionConfig {
  /** LINSTOR master passphrase for LUKS key encryption */
  passphrase: string;
}

/** Storage pool configuration */
export interface PiraeusStoragePoolConfig {
  /** Pool name (defaults to "lvm-thin") */
  name?: string;
  /** Storage pool type */
  type: "lvmThin" | "lvm" | "fileThin";
  /** LVM volume group name (for lvmThin/lvm) */
  volumeGroup?: string;
  /** LVM thin pool name (for lvmThin) */
  thinPool?: string;
  /** Directory path (for fileThin) */
  directory?: string;
  /** Raw block devices to auto-create the pool from */
  hostDevices?: string[];
}

/** Replication configuration */
export interface PiraeusReplicationConfig {
  /** Number of replicas per volume (defaults to 1) */
  placementCount?: number;
  /** Enable DRBD Protocol A (async) for cross-zone node connections */
  crossSiteAsync?: boolean;
  /** TCP send buffer size in bytes for async replication (defaults to "1048576") */
  sndBufSize?: string;
}

export interface PiraeusConfig {
  /** Namespace (defaults to "piraeus-datastore") */
  namespace?: string;
  /** Piraeus Operator version (defaults to "v2.10.4") */
  operatorVersion?: string;
  /** linstor-cluster Helm chart version (defaults to "1.1.1") */
  clusterChartVersion?: string;
  /** Encrypted StorageClass name (defaults to "linstor-encrypted") */
  storageClassName?: string;
  /** LUKS encryption configuration */
  encryption?: PiraeusEncryptionConfig;
  /** Storage pool configuration */
  storagePool?: PiraeusStoragePoolConfig;
  /** Replication configuration */
  replication?: PiraeusReplicationConfig;
  /** Additional Helm values for linstor-cluster chart */
  values?: Record<string, unknown>;
}

export class Piraeus extends BaseConstruct<PiraeusConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly storageClassName: string;

  constructor(scope: Construct, id: string, config: PiraeusConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "piraeus-datastore";
    const operatorVersion = this.config.operatorVersion ?? "v2.10.4";
    this.storageClassName = this.config.storageClassName ?? "linstor-encrypted";
    const poolName = this.config.storagePool?.name ?? "lvm-thin";
    const placementCount = this.config.replication?.placementCount ?? 1;

    // Namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // --- Piraeus Operator ---

    new Include(this, "piraeus-operator", {
      url: `https://github.com/piraeusdatastore/piraeus-operator/releases/download/${operatorVersion}/manifest.yaml`,
    });

    // --- LINSTOR Passphrase Secret ---

    if (this.config.encryption) {
      new kplus.Secret(this, "passphrase-secret", {
        metadata: { name: "linstor-passphrase", namespace: namespaceName },
        stringData: {
          MASTER_PASSPHRASE: this.config.encryption.passphrase,
        },
      });
    }

    // --- LinstorCluster ---

    new ApiObject(this, "linstor-cluster", {
      apiVersion: "piraeus.io/v1",
      kind: "LinstorCluster",
      metadata: { name: "linstorcluster" },
      spec: {
        ...(this.config.encryption
          ? { linstorPassphraseSecret: "linstor-passphrase" }
          : {}),
      },
    });

    // --- LinstorSatelliteConfiguration ---

    if (this.config.storagePool) {
      const pool = this.config.storagePool;
      const poolSpec = buildStoragePoolSpec(pool, poolName);

      new ApiObject(this, "satellite-config", {
        apiVersion: "piraeus.io/v1",
        kind: "LinstorSatelliteConfiguration",
        metadata: { name: "storage-config" },
        spec: {
          podTemplate: {
            spec: {
              hostNetwork: true,
            },
          },
          storagePools: [poolSpec],
        },
      });
    }

    // --- LinstorNodeConnection (cross-zone async) ---

    if (this.config.replication?.crossSiteAsync) {
      const sndBufSize = this.config.replication.sndBufSize ?? "1048576";

      new ApiObject(this, "cross-zone-async", {
        apiVersion: "piraeus.io/v1",
        kind: "LinstorNodeConnection",
        metadata: { name: "cross-zone-async" },
        spec: {
          selector: [
            {
              matchLabels: [
                {
                  key: "topology.kubernetes.io/zone",
                  op: "NotSame",
                },
              ],
            },
          ],
          properties: [
            { name: "DrbdOptions/Net/protocol", value: "A" },
            { name: "DrbdOptions/Net/sndbuf-size", value: sndBufSize },
            { name: "DrbdOptions/Net/rcvbuf-size", value: sndBufSize },
          ],
        },
      });
    }

    // --- Encrypted StorageClass ---

    new KubeStorageClass(this, "storage-class", {
      metadata: { name: this.storageClassName },
      provisioner: "linstor.csi.linbit.com",
      allowVolumeExpansion: true,
      reclaimPolicy: "Retain",
      volumeBindingMode: "WaitForFirstConsumer",
      parameters: {
        "linstor.csi.linbit.com/storagePool": poolName,
        "linstor.csi.linbit.com/placementCount": String(placementCount),
        "linstor.csi.linbit.com/layerList": this.config.encryption
          ? "drbd luks storage"
          : "drbd storage",
        ...(this.config.encryption
          ? { "linstor.csi.linbit.com/encryption": "true" }
          : {}),
        "csi.storage.k8s.io/fstype": "ext4",
      },
    });
  }
}

function buildStoragePoolSpec(
  pool: PiraeusStoragePoolConfig,
  poolName: string,
): Record<string, unknown> {
  const spec: Record<string, unknown> = { name: poolName };

  switch (pool.type) {
    case "lvmThin":
      spec.lvmThinPool = {
        ...(pool.volumeGroup ? { volumeGroup: pool.volumeGroup } : {}),
        ...(pool.thinPool ? { thinPool: pool.thinPool } : {}),
      };
      break;
    case "lvm":
      spec.lvmPool = {
        ...(pool.volumeGroup ? { volumeGroup: pool.volumeGroup } : {}),
      };
      break;
    case "fileThin":
      spec.fileThinPool = {
        ...(pool.directory ? { directory: pool.directory } : {}),
      };
      break;
  }

  if (pool.hostDevices?.length) {
    spec.source = { hostDevices: pool.hostDevices };
  }

  return spec;
}
