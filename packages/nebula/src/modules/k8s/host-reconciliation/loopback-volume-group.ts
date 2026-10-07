import { Construct } from "constructs";
import { KubeDaemonSet } from "cdk8s-plus-33/lib/imports/k8s";
import { type HostReconcilerConfig, validateHostReconciler } from "./shared";
import { loopbackVolumeGroupScript } from "./scripts";

export interface LoopbackVolumeGroupConfig extends HostReconcilerConfig {
  volumeGroup: string;
  directory: string;
  sizeBytes: number;
  evictionPercent: number;
  headroomBytes: number;
  firstPinnedLoop: number;
  /** An explicit acknowledgement equal to sizeBytes authorizes growth. */
  growTo?: number;
  commandName: string;
  logPrefix: string;
}

/** Reconcile one existing loop/LVM contract without deleting backing storage. */
export class LoopbackVolumeGroup extends Construct {
  constructor(scope: Construct, id: string, config: LoopbackVolumeGroupConfig) {
    super(scope, id);
    validateHostReconciler(config);
    for (const value of [config.sizeBytes, config.headroomBytes, config.firstPinnedLoop]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("volume group sizes and reserved loop boundary must be positive safe integers");
    }
    if (!Number.isInteger(config.evictionPercent) || config.evictionPercent < 1 || config.evictionPercent > 99) throw new Error("evictionPercent must be between 1 and 99");
    if (config.growTo !== undefined && config.growTo !== config.sizeBytes) throw new Error("growTo must explicitly equal sizeBytes");
    const script = loopbackVolumeGroupScript({ logPrefix: config.logPrefix });
    const onHost = ["nsenter", "--mount=/host/proc/1/ns/mnt", "--ipc=/host/proc/1/ns/ipc", "--", "/bin/sh", "-c", script, config.commandName];
    const env = [
      { name: "VG", value: config.volumeGroup },
      { name: "DIR", value: config.directory },
      { name: "SIZE", value: String(config.sizeBytes) },
      { name: "EVICTION_PERCENT", value: String(config.evictionPercent) },
      { name: "HEADROOM", value: String(config.headroomBytes) },
      { name: "FIRST_PINNED_LOOP", value: String(config.firstPinnedLoop) },
      ...(config.growTo === undefined ? [] : [{ name: "GROW_TO", value: String(config.growTo) }]),
    ];
    const securityContext = { privileged: true, runAsUser: 0 };
    const volumeMounts = [{ name: "host-proc", mountPath: "/host/proc", readOnly: true }];

    new KubeDaemonSet(this, "daemonset", {
      metadata: { name: config.name, namespace: config.namespace },
      spec: {
        selector: { matchLabels: { app: config.name } },
        template: {
          metadata: { labels: { app: config.name } },
          spec: {
            nodeSelector: config.nodeSelector,
            tolerations: config.tolerations ?? [{ operator: "Exists" }],
            automountServiceAccountToken: false,
            initContainers: [
              { name: "apply", image: config.image, command: [...onHost, "apply"], env, securityContext, volumeMounts },
            ],
            containers: [
              {
                name: "verify",
                image: config.image,
                command: ["sleep", "infinity"],
                env,
                securityContext,
                volumeMounts,
                readinessProbe: {
                  exec: { command: [...onHost, "check"] },
                  periodSeconds: 300,
                  timeoutSeconds: 60,
                  failureThreshold: 1,
                },
              },
            ],
            volumes: [{ name: "host-proc", hostPath: { path: "/proc", type: "Directory" } }],
          },
        },
      },
    });
  }
}
