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
  /** LINSTOR net-interface name for cross-site DRBD paths (requires advertiseIP on satellites) */
  replicationInterface?: string;
}

/** Additional satellite configuration for nodes with different storage devices */
export interface PiraeusSatelliteConfig {
  /** Unique name for this satellite configuration */
  name: string;
  /** Node selector to match specific nodes (used as nodeAffinity) */
  nodeSelector: Record<string, string>;
  /** Storage pool configuration for these nodes */
  storagePool: PiraeusStoragePoolConfig;
  /** Shell command that outputs this satellite's replication IP (runs in sidecar with hostNetwork) */
  advertiseIP?: string;
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
  /** Storage pool configuration (default, applies to nodes not matched by additionalSatellites) */
  storagePool?: PiraeusStoragePoolConfig;
  /** Additional satellite configurations for nodes with different device paths */
  additionalSatellites?: PiraeusSatelliteConfig[];
  /** Replication configuration */
  replication?: PiraeusReplicationConfig;
  /** Kubelet path override for k0s (defaults to "/var/lib/kubelet", k0s uses "/var/lib/k0s/kubelet") */
  kubeletPath?: string;
  /** Shell command that outputs the default satellite's replication IP (runs in sidecar with hostNetwork) */
  advertiseIP?: string;
  /** Additional Helm values for linstor-cluster chart */
  values?: Record<string, unknown>;
}

export class Piraeus extends BaseConstruct<PiraeusConfig> {
  public readonly storageClassName: string;

  constructor(scope: Construct, id: string, config: PiraeusConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "piraeus-datastore";
    const operatorVersion = this.config.operatorVersion ?? "v2.10.4";
    this.storageClassName = this.config.storageClassName ?? "linstor-encrypted";
    const poolName = this.config.storagePool?.name ?? "lvm-thin";
    const placementCount = this.config.replication?.placementCount ?? 1;

    // --- Piraeus Operator (includes the piraeus-datastore Namespace) ---

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

    const kubeletPath = this.config.kubeletPath;
    const clusterSpec: Record<string, unknown> = {
      ...(this.config.encryption
        ? { linstorPassphraseSecret: "linstor-passphrase" }
        : {}),
    };

    // k0s (and similar distros) use a non-standard kubelet path
    if (kubeletPath) {
      const pluginPath = `${kubeletPath}/plugins/linstor.csi.linbit.com`;
      clusterSpec.csiNode = {
        enabled: true,
        podTemplate: {
          spec: {
            containers: [
              {
                name: "linstor-csi",
                volumeMounts: [
                  {
                    mountPath: kubeletPath,
                    name: "publish-dir",
                    mountPropagation: "Bidirectional",
                  },
                ],
              },
              {
                name: "csi-node-driver-registrar",
                args: [
                  "--v=5",
                  "--csi-address=/csi/csi.sock",
                  `--kubelet-registration-path=${pluginPath}/csi.sock`,
                  "--health-port=9809",
                ],
              },
            ],
            volumes: [
              {
                name: "publish-dir",
                hostPath: { path: kubeletPath },
              },
              {
                name: "registration-dir",
                hostPath: { path: `${kubeletPath}/plugins_registry` },
              },
              {
                name: "plugin-dir",
                hostPath: { path: pluginPath },
              },
            ],
          },
        },
      };
    }

    new ApiObject(this, "linstor-cluster", {
      apiVersion: "piraeus.io/v1",
      kind: "LinstorCluster",
      metadata: { name: "linstorcluster" },
      spec: clusterSpec,
    });

    // --- LinstorSatelliteConfiguration ---

    const replicationInterface = this.config.replication?.replicationInterface;

    if (this.config.storagePool) {
      const pool = this.config.storagePool;
      const poolSpec = buildStoragePoolSpec(pool, poolName);

      // When additionalSatellites exist, restrict default config to nodes NOT
      // matched by any additional satellite (they have different device paths)
      let nodeAffinity: Record<string, unknown> | undefined;
      if (this.config.additionalSatellites?.length) {
        const excludeExpressions = this.config.additionalSatellites.flatMap(
          (sat) =>
            Object.entries(sat.nodeSelector).map(([key, value]) => ({
              key,
              operator: "NotIn",
              values: [value],
            })),
        );
        nodeAffinity = {
          nodeSelectorTerms: [{ matchExpressions: excludeExpressions }],
        };
      }

      const podSpec: Record<string, unknown> = { hostNetwork: true };
      if (this.config.advertiseIP && replicationInterface) {
        podSpec.dnsPolicy = "ClusterFirstWithHostNet";
        podSpec.containers = [
          buildDrbdIpSidecar(
            this.config.advertiseIP,
            replicationInterface,
            namespaceName,
          ),
        ];
      }

      new ApiObject(this, "satellite-config", {
        apiVersion: "piraeus.io/v1",
        kind: "LinstorSatelliteConfiguration",
        metadata: { name: "storage-config" },
        spec: {
          ...(nodeAffinity && { nodeAffinity }),
          podTemplate: { spec: podSpec },
          storagePools: [poolSpec],
        },
      });
    }

    // --- Additional LinstorSatelliteConfigurations (for nodes with different devices) ---

    if (this.config.additionalSatellites?.length) {
      for (const sat of this.config.additionalSatellites) {
        const satPoolSpec = buildStoragePoolSpec(
          sat.storagePool,
          sat.storagePool.name ?? poolName,
        );

        const matchExpressions = Object.entries(sat.nodeSelector).map(
          ([key, value]) => ({
            key,
            operator: "In",
            values: [value],
          }),
        );

        const podSpec: Record<string, unknown> = { hostNetwork: true };
        if (sat.advertiseIP && replicationInterface) {
          podSpec.dnsPolicy = "ClusterFirstWithHostNet";
          podSpec.containers = [
            buildDrbdIpSidecar(
              sat.advertiseIP,
              replicationInterface,
              namespaceName,
            ),
          ];
        }

        new ApiObject(this, `satellite-config-${sat.name}`, {
          apiVersion: "piraeus.io/v1",
          kind: "LinstorSatelliteConfiguration",
          metadata: { name: `storage-config-${sat.name}` },
          spec: {
            nodeAffinity: {
              nodeSelectorTerms: [{ matchExpressions }],
            },
            podTemplate: { spec: podSpec },
            storagePools: [satPoolSpec],
          },
        });
      }
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
          ...(replicationInterface && {
            paths: [{ name: "replication", interface: replicationInterface }],
          }),
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

/**
 * Builds a sidecar container spec that registers a LINSTOR net-interface with
 * the satellite's replication IP. Waits for the satellite to come online, then
 * creates/updates the interface via the LINSTOR REST API.
 */
function buildDrbdIpSidecar(
  ipCommand: string,
  interfaceName: string,
  namespace: string,
): Record<string, unknown> {
  const ctrl = `http://linstor-controller.${namespace}.svc:3370`;
  const script = [
    `IFACE="${interfaceName}"`,
    `CTRL="${ctrl}"`,
    `until curl -sf "$CTRL/v1/controller/version" >/dev/null 2>&1; do echo "Waiting for LINSTOR controller..."; sleep 5; done`,
    `NODE="$NODE_NAME"`,
    `until curl -sf "$CTRL/v1/nodes/$NODE" | grep -q ONLINE; do echo "Waiting for satellite $NODE..."; sleep 5; done`,
    `IP=$(${ipCommand})`,
    `echo "Registering LINSTOR net-interface $IFACE=$IP on $NODE"`,
    `curl -sf -X PUT "$CTRL/v1/nodes/$NODE/net-interfaces/$IFACE" -H "Content-Type: application/json" -d "{\\"address\\": \\"$IP\\"}" || curl -sf -X POST "$CTRL/v1/nodes/$NODE/net-interfaces" -H "Content-Type: application/json" -d "{\\"name\\": \\"$IFACE\\", \\"address\\": \\"$IP\\"}"`,
    `echo "Done. Sleeping."`,
    `sleep infinity`,
  ].join("\n");

  return {
    name: "register-drbd-ip",
    image: "curlimages/curl:latest",
    command: ["/bin/sh", "-c"],
    args: [script],
    env: [
      {
        name: "NODE_NAME",
        valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
      },
    ],
  };
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
