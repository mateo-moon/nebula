import { Construct } from "constructs";
import { KubeDaemonSet } from "cdk8s-plus-33/lib/imports/k8s";
import { type HostReconcilerConfig, validateHostReconciler } from "./shared";
import { packageFreezeScript } from "./scripts";

export interface HostPackageFreezeConfig extends HostReconcilerConfig {
  freeze: "on" | "off";
  packages: readonly string[];
  frozenFiles: Readonly<Record<string, string>>;
}

export class HostPackageFreeze extends Construct {
  constructor(scope: Construct, id: string, config: HostPackageFreezeConfig) {
    super(scope, id);
    validateHostReconciler(config);
    const script = packageFreezeScript();
    const env = [
      { name: "FREEZE", value: config.freeze },
      { name: "HOLD_PACKAGES", value: config.packages.join(" ") },
      { name: "FROZEN_FILES", value: Object.entries(config.frozenFiles).map(([path, hash]) => `${path}=${hash}`).join(" ") },
    ];
    const firmware = { name: "firmware", mountPath: "/host/usr/lib/firmware", readOnly: true };
    const confined = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
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
              {
                name: "hold",
                image: config.image,
                command: ["/bin/sh", "-c", script, "freeze", "apply"],
                env,
                securityContext: { ...confined, runAsUser: 0 },
                volumeMounts: [{ name: "dpkg", mountPath: "/host/var/lib/dpkg" }, firmware],
              },
            ],
            containers: [
              {
                name: "verify",
                image: config.image,
                command: ["sleep", "infinity"],
                env,
                securityContext: { ...confined, runAsUser: 65534, runAsNonRoot: true },
                volumeMounts: [{ name: "dpkg", mountPath: "/host/var/lib/dpkg", readOnly: true }, firmware],
                readinessProbe: {
                  exec: { command: ["/bin/sh", "-c", script, "freeze", "check"] },
                  periodSeconds: 300,
                  timeoutSeconds: 60,
                  failureThreshold: 1,
                },
              },
            ],
            volumes: [
              { name: "dpkg", hostPath: { path: "/var/lib/dpkg", type: "Directory" } },
              { name: "firmware", hostPath: { path: "/usr/lib/firmware", type: "Directory" } },
            ],
          },
        },
      },
    });
  }
}
