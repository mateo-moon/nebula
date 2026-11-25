import { Construct } from "constructs";
import { IntOrString, KubeDaemonSet, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { type HostReconcilerConfig, validateHostReconciler } from "./shared";
import { hostKernelModulesScript } from "./scripts";

/** Reviewed host prerequisites, expanded only through an explicit code review. */
export type HostKernelModule = "dm_thin_pool";

export interface HostKernelModulesConfig extends HostReconcilerConfig {
  modules: readonly HostKernelModule[];
}

/** Load installed, signed Debian kernel modules and retain their boot declaration.
 * This does not create pools, LVs or filesystems. */
export class HostKernelModules extends Construct {
  constructor(scope: Construct, id: string, config: HostKernelModulesConfig) {
    super(scope, id);
    validateHostReconciler(config);
    const hostname = config.nodeSelector["kubernetes.io/hostname"];
    if (!hostname || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(hostname)) {
      throw new Error("kernel modules require an explicit host name selector");
    }
    if (!Array.isArray(config.modules) || !config.modules.length ||
        config.modules.some(module => module !== "dm_thin_pool") ||
        new Set(config.modules).size !== config.modules.length) {
      throw new Error("kernel modules require unique reviewed module names");
    }
    const script = hostKernelModulesScript();
    const env = [
      { name: "KERNEL_MODULES", value: [...config.modules].sort().join(" ") },
      { name: "MODULES_FILE", value: `90-nebula-${config.name}.conf` },
    ];
    const retained = { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" };
    new KubeDaemonSet(this, "daemonset", {
      metadata: { name: config.name, namespace: config.namespace, annotations: retained },
      spec: {
        selector: { matchLabels: { app: config.name } },
        updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: IntOrString.fromNumber(1) } },
        template: { metadata: { labels: { app: config.name } }, spec: {
          nodeSelector: config.nodeSelector,
          tolerations: config.tolerations ?? [{ operator: "Exists" }],
          automountServiceAccountToken: false,
          initContainers: [{
            name: "load", image: config.image,
            // Enter the host's mount namespace AND root explicitly: kmod must
            // use that running kernel's installed modules and package database.
            command: ["timeout", "60s", "nsenter", "--mount=/host/proc/1/ns/mnt",
              "--root=/host/proc/1/root", "--wdns=/", "--", "/bin/sh", "-c", script, "host-modules", "apply"],
            env, securityContext: { privileged: true, runAsUser: 0, readOnlyRootFilesystem: true },
            volumeMounts: [{ name: "host-proc", mountPath: "/host/proc", readOnly: true }],
            resources: { requests: { cpu: Quantity.fromString("5m"), memory: Quantity.fromString("16Mi") },
              limits: { memory: Quantity.fromString("64Mi") } },
          }],
          containers: [{
            name: "verify", image: config.image, command: ["sleep", "infinity"],
            env: [...env, { name: "HOST_ROOT", value: "/host" }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              runAsUser: 65534, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
            volumeMounts: [
              { name: "modules-load", mountPath: "/host/etc/modules-load.d", readOnly: true },
              { name: "loaded-modules", mountPath: "/host/sys/module", readOnly: true },
            ],
            resources: { requests: { cpu: Quantity.fromString("5m"), memory: Quantity.fromString("16Mi") },
              limits: { memory: Quantity.fromString("32Mi") } },
            readinessProbe: { exec: { command: ["/bin/sh", "-c", script, "host-modules", "check"] },
              periodSeconds: 300, timeoutSeconds: 10, failureThreshold: 1 },
          }],
          volumes: [
            { name: "host-proc", hostPath: { path: "/proc", type: "Directory" } },
            { name: "modules-load", hostPath: { path: "/etc/modules-load.d", type: "DirectoryOrCreate" } },
            { name: "loaded-modules", hostPath: { path: "/sys/module", type: "Directory" } },
          ],
        } },
      },
    });
  }
}
