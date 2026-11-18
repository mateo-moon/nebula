import { Construct } from "constructs";
import { createHostReconcilerDaemonSet, type HostReconcilerConfig, validateHostReconciler } from "./shared";
import { kernelPinScript, type HostKernelPinScriptOptions } from "./scripts";

export interface HostKernelPinConfig extends HostReconcilerConfig, HostKernelPinScriptOptions {
  freeze: "on" | "off";
  kernel: string;
  grubEntry: string;
}

export class HostKernelPin extends Construct {
  constructor(scope: Construct, id: string, config: HostKernelPinConfig) {
    super(scope, id);
    validateHostReconciler(config);
    if (!["on", "off"].includes(config.freeze)) throw new Error("freeze must be on or off");
    if (!/^[a-zA-Z0-9._>-]+$/.test(config.kernel) || !/^[a-zA-Z0-9._>-]+$/.test(config.grubEntry)) throw new Error("kernel and GRUB entry must be plain identifiers");
    const pinScript = kernelPinScript(config);
    const pinEnv = [
      { name: "FREEZE", value: config.freeze },
      { name: "KERNEL", value: config.kernel },
      { name: "GRUB_ENTRY", value: config.grubEntry },
    ];
    const confined = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
    createHostReconcilerDaemonSet(this, config, {
      apply: {
        name: "pin",
        command: ["nsenter", "--mount=/host/proc/1/ns/mnt", "--", "/bin/sh", "-c", pinScript, "kernel-pin", "apply"],
        env: pinEnv,
        securityContext: { privileged: true, runAsUser: 0 },
        volumeMounts: [{ name: "host-proc", mountPath: "/host/proc", readOnly: true }],
      },
      verify: {
        checkCommand: ["/bin/sh", "-c", pinScript, "kernel-pin", "check"],
        env: [...pinEnv, { name: "HOST_ROOT", value: "/host" }],
        securityContext: { ...confined, runAsUser: 0 },
        volumeMounts: [
          { name: "grub", mountPath: "/host/boot/grub", readOnly: true },
          { name: "grub-defaults", mountPath: "/host/etc/default", readOnly: true },
        ],
      },
      volumes: [
        { name: "host-proc", hostPath: { path: "/proc", type: "Directory" } },
        { name: "grub", hostPath: { path: "/boot/grub", type: "Directory" } },
        { name: "grub-defaults", hostPath: { path: "/etc/default", type: "Directory" } },
      ],
    });
  }
}
