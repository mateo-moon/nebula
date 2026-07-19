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

/** LINSTOR CSI StorageClass configuration */
export interface PiraeusStorageClassConfig {
  /** StorageClass name (defaults to storageClassName, then "linstor-encrypted") */
  name?: string;
  /** Mark this StorageClass as the cluster default */
  isDefault?: boolean;
  /** Additional StorageClass annotations */
  annotations?: Record<string, string>;
  /** LINSTOR storage pool used by the class */
  storagePool?: string;
  /** LINSTOR resource group used by the class (defaults to the class name) */
  resourceGroup?: string;
  /** Reclaim policy (defaults to Retain) */
  reclaimPolicy?: "Delete" | "Retain";
  /** Volume binding mode (defaults to WaitForFirstConsumer) */
  volumeBindingMode?: "Immediate" | "WaitForFirstConsumer";
  /** Allow PVC expansion (defaults to true) */
  allowVolumeExpansion?: boolean;
  /** Extra LINSTOR CSI parameters, merged over the generated defaults */
  parameters?: Record<string, string>;
}

export interface PiraeusConfig {
  /**
   * Namespace (must be "piraeus-datastore", the default).
   * The bundled upstream operator manifest is published with a hardcoded
   * "piraeus-datastore" namespace, and the controller resolves the passphrase
   * secret and the linstor-controller Service in its own namespace, so this
   * cannot currently be changed without breaking the deployment.
   */
  namespace?: string;
  /** Piraeus Operator version (defaults to "v2.10.7") */
  operatorVersion?: string;
  /** StorageClass name (legacy shorthand; defaults to "linstor-encrypted") */
  storageClassName?: string;
  /** StorageClass configuration */
  storageClass?: PiraeusStorageClassConfig;
  /** LUKS encryption configuration */
  encryption?: PiraeusEncryptionConfig;
  /**
   * Existing LINSTOR master-passphrase Secret. This unlocks encrypted LINSTOR
   * database fields (for example EBS remote credentials) without implicitly
   * enabling the LUKS volume layer.
   */
  masterPassphraseSecret?: string;
  /** Storage pool configuration (default, applies to nodes not matched by additionalSatellites) */
  storagePool?: PiraeusStoragePoolConfig;
  /** Additional satellite configurations for nodes with different device paths */
  additionalSatellites?: PiraeusSatelliteConfig[];
  /** Replication configuration */
  replication?: PiraeusReplicationConfig;
  /** Kubelet path override for k0s (defaults to "/var/lib/kubelet", k0s uses "/var/lib/k0s/kubelet") */
  kubeletPath?: string;
  /** Use host networking for LINSTOR satellites (defaults to true; set false when CNI provides cross-node routing) */
  hostNetwork?: boolean;
  /**
   * Allow the controller to launch local special satellites for storage
   * providers such as EBS_TARGET and remote SPDK. The controller keeps a
   * read-only root filesystem; only its configuration and generated DRBD
   * configuration directories become writable, with linstor.toml mounted
   * back from the ConfigMap read-only. The pod hostname is pinned because
   * special satellites authenticate with the controller's uname, which must
   * stay stable across controller reschedules.
   */
  enableSpecialSatellites?: boolean;
  /** Shell command that outputs the default satellite's replication IP (runs in sidecar with hostNetwork) */
  advertiseIP?: string;
}

const SPECIAL_SATELLITE_CONTROLLER_PATCH = String.raw`apiVersion: apps/v1
kind: Deployment
metadata:
  name: linstor-controller
spec:
  template:
    spec:
      hostname: linstor-controller
      containers:
        - name: linstor-controller
          volumeMounts:
            - $patch: replace
            - name: var-log-linstor-controller
              mountPath: /var/log/linstor-controller
            - name: etc-linstor-writable
              mountPath: /etc/linstor
            - name: etc-linstor
              mountPath: /etc/linstor/linstor.toml
              subPath: linstor.toml
              readOnly: true
            - name: var-lib-linstor-d
              mountPath: /var/lib/linstor.d
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: etc-linstor-writable
          emptyDir: {}
        - name: var-lib-linstor-d
          emptyDir: {}
`;

export class Piraeus extends BaseConstruct<PiraeusConfig> {
  public readonly storageClassName: string;

  constructor(scope: Construct, id: string, config: PiraeusConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "piraeus-datastore";
    // The upstream operator manifest pulled in via Include below hardcodes the
    // "piraeus-datastore" namespace. The passphrase secret (created here) and
    // the DRBD sidecar's controller DNS target are placed in `namespaceName`,
    // and the controller looks for both in its own namespace. Overriding the
    // namespace would silently break LUKS encryption setup and net-interface
    // registration, so reject any value that diverges from the operator's.
    if (namespaceName !== "piraeus-datastore") {
      throw new Error(
        `Piraeus: namespace must be "piraeus-datastore" (got "${namespaceName}"). ` +
          "The bundled operator manifest is published with that namespace " +
          "hardcoded, so overriding it would break the passphrase secret and " +
          "DRBD sidecar wiring.",
      );
    }
    const operatorVersion = this.config.operatorVersion ?? "v2.10.7";
    const storageClass = this.config.storageClass ?? {};
    this.storageClassName =
      storageClass.name ?? this.config.storageClassName ?? "linstor-encrypted";
    const poolName =
      storageClass.storagePool ??
      this.config.storagePool?.name ??
      "lvm-thin";
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
    const useHostNetwork = this.config.hostNetwork ?? true;
    const masterPassphraseSecret =
      this.config.masterPassphraseSecret ??
      (this.config.encryption ? "linstor-passphrase" : undefined);
    const clusterSpec: Record<string, unknown> = {
      ...(masterPassphraseSecret
        ? { linstorPassphraseSecret: masterPassphraseSecret }
        : {}),
      ...(this.config.enableSpecialSatellites
        ? {
            patches: [
              {
                target: {
                  group: "apps",
                  version: "v1",
                  kind: "Deployment",
                  name: "linstor-controller",
                },
                patch: SPECIAL_SATELLITE_CONTROLLER_PATCH,
              },
            ],
          }
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

      const podSpec = buildSatellitePodSpec(
        useHostNetwork,
        this.config.advertiseIP,
        replicationInterface,
        namespaceName,
      );

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

        const podSpec = buildSatellitePodSpec(
          useHostNetwork,
          sat.advertiseIP,
          replicationInterface,
          namespaceName,
        );

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

    // --- LINSTOR CSI StorageClass ---

    const storageClassAnnotations = {
      ...storageClass.annotations,
      ...(storageClass.isDefault
        ? { "storageclass.kubernetes.io/is-default-class": "true" }
        : {}),
    };

    new KubeStorageClass(this, "storage-class", {
      metadata: {
        name: this.storageClassName,
        ...(Object.keys(storageClassAnnotations).length > 0
          ? { annotations: storageClassAnnotations }
          : {}),
      },
      provisioner: "linstor.csi.linbit.com",
      allowVolumeExpansion: storageClass.allowVolumeExpansion ?? true,
      reclaimPolicy: storageClass.reclaimPolicy ?? "Retain",
      volumeBindingMode:
        storageClass.volumeBindingMode ?? "WaitForFirstConsumer",
      parameters: {
        "linstor.csi.linbit.com/storagePool": poolName,
        "linstor.csi.linbit.com/placementCount": String(placementCount),
        "linstor.csi.linbit.com/resourceGroup":
          storageClass.resourceGroup ?? this.storageClassName,
        "linstor.csi.linbit.com/layerList": this.config.encryption
          ? "drbd luks storage"
          : "drbd storage",
        ...(this.config.encryption
          ? { "linstor.csi.linbit.com/encryption": "true" }
          : {}),
        "csi.storage.k8s.io/fstype": "ext4",
        ...storageClass.parameters,
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
  // curl in the Alpine-based curlimages/curl image can't resolve cluster DNS
  // from hostNetwork pods (musl libc getaddrinfo issue with kube-dns ClusterIP).
  // Resolve the controller IP via nslookup first, then use curl with the IP.
  const svcHost = `linstor-controller.${namespace}.svc.cluster.local`;
  const script = [
    `IFACE="${interfaceName}"`,
    `SVC="${svcHost}"`,
    // Resolve controller ClusterIP via nslookup (works even when curl DNS fails)
    `echo "Resolving LINSTOR controller service..."`,
    `until CTRL_IP=$(nslookup "$SVC" 2>/dev/null | awk '/^Address:/{ip=$2} END{print ip}'); [ -n "$CTRL_IP" ]; do echo "Waiting for DNS..."; sleep 5; done`,
    `CTRL="http://$CTRL_IP:3370"`,
    `echo "Controller at $CTRL"`,
    `until curl -sf "$CTRL/v1/controller/version" >/dev/null 2>&1; do echo "Waiting for LINSTOR controller..."; sleep 5; done`,
    `NODE="$NODE_NAME"`,
    `until curl -sf "$CTRL/v1/nodes/$NODE" | grep -q ONLINE; do echo "Waiting for satellite $NODE..."; sleep 5; done`,
    `IP=$(${ipCommand})`,
    `echo "Registering LINSTOR net-interface $IFACE=$IP on $NODE"`,
    `curl -sf -X PUT "$CTRL/v1/nodes/$NODE/net-interfaces/$IFACE" -H "Content-Type: application/json" -d "{\\"address\\": \\"$IP\\"}" || \\`,
    `curl -sf -X POST "$CTRL/v1/nodes/$NODE/net-interfaces" -H "Content-Type: application/json" -d "{\\"name\\": \\"$IFACE\\", \\"address\\": \\"$IP\\"}"`,
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

/**
 * Builds the LinstorSatelliteConfiguration podTemplate spec: host networking
 * plus, when an advertise-IP command and a replication interface are supplied,
 * the DRBD net-interface registration sidecar (with host-net-friendly DNS).
 */
function buildSatellitePodSpec(
  useHostNetwork: boolean,
  advertiseIP: string | undefined,
  replicationInterface: string | undefined,
  namespace: string,
): Record<string, unknown> {
  const podSpec: Record<string, unknown> = { hostNetwork: useHostNetwork };
  if (advertiseIP && replicationInterface) {
    if (useHostNetwork) podSpec.dnsPolicy = "ClusterFirstWithHostNet";
    podSpec.containers = [
      buildDrbdIpSidecar(advertiseIP, replicationInterface, namespace),
    ];
  }
  return podSpec;
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
