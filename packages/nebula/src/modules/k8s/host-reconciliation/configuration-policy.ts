import { Construct } from "constructs";
import { createHostReconcilerDaemonSet, type HostReconcilerConfig, validateHostReconciler } from "./shared";
import { hostConfigurationPolicyScript } from "./scripts";

export interface DebianHostPolicyConfig extends HostReconcilerConfig {
  provenance: string;
  upgradeBlacklist: readonly string[];
  sysctls: Readonly<Record<string, string>>;
}

export class DebianHostPolicy extends Construct {
  constructor(scope: Construct, id: string, config: DebianHostPolicyConfig) {
    super(scope, id);
    validateHostReconciler(config);
    if (!config.provenance || /[\r\n\0]/.test(config.provenance)) throw new Error("host policy provenance must be one nonempty line");
    if (!config.upgradeBlacklist.every(value => /^[a-zA-Z0-9.+*?:_-]+$/.test(value))) throw new Error("upgrade blacklist entries must be plain package patterns");
    for (const [key, value] of Object.entries(config.sysctls)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(key) || !/^-?[0-9]+(?:[ \t]+-?[0-9]+)*$/.test(value)) {
        throw new Error("sysctls require plain keys and integer values");
      }
    }
    const policyScript = hostConfigurationPolicyScript();
    const policyEnv = [
      {
        name: "APT_POLICY",
        value: [
          `// ${config.provenance}`,
          "Unattended-Upgrade::Package-Blacklist {",
          ...config.upgradeBlacklist.map(p => `  "${p}";`),
          "};",
          'Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";',
          'Unattended-Upgrade::Remove-New-Unused-Dependencies "false";',
          'Unattended-Upgrade::Automatic-Reboot "false";',
        ].join("\n"),
      },
      { name: "NEEDRESTART_POLICY", value: [`# ${config.provenance}`, "$nrconf{restart} = 'l';"].join("\n") },
      {
        name: "SYSCTL_POLICY",
        value: [`# ${config.provenance}`, ...Object.entries(config.sysctls).map(([k, v]) => `${k} = ${v}`)].join("\n"),
      },
    ];
    const policyDirs = [
      { name: "apt-conf", path: "/etc/apt/apt.conf.d", type: "Directory" },
      { name: "needrestart-conf", path: "/etc/needrestart/conf.d", type: "DirectoryOrCreate" },
      { name: "sysctl-conf", path: "/etc/sysctl.d", type: "Directory" },
    ];
    const confined = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
    createHostReconcilerDaemonSet(this, config, {
      apply: {
        name: "write",
        command: ["/bin/sh", "-c", policyScript, "host-policy", "apply"],
        env: policyEnv,
        securityContext: { ...confined, runAsUser: 0 },
        volumeMounts: policyDirs.map(d => ({ name: d.name, mountPath: `/host${d.path}` })),
      },
      verify: {
        checkCommand: ["/bin/sh", "-c", policyScript, "host-policy", "check"],
        env: policyEnv,
        securityContext: { ...confined, runAsUser: 65534, runAsNonRoot: true },
        volumeMounts: policyDirs.map(d => ({ name: d.name, mountPath: `/host${d.path}`, readOnly: true })),
      },
      volumes: policyDirs.map(d => ({ name: d.name, hostPath: { path: d.path, type: d.type } })),
    });
  }
}
