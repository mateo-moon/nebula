import { Construct } from "constructs";
import { KubeDaemonSet } from "cdk8s-plus-33/lib/imports/k8s";
import { type HostReconcilerConfig, validateHostReconciler } from "./shared";
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
                name: "write",
                image: config.image,
                command: ["/bin/sh", "-c", policyScript, "host-policy", "apply"],
                env: policyEnv,
                securityContext: { ...confined, runAsUser: 0 },
                volumeMounts: policyDirs.map(d => ({ name: d.name, mountPath: `/host${d.path}` })),
              },
            ],
            containers: [
              {
                name: "verify",
                image: config.image,
                command: ["sleep", "infinity"],
                env: policyEnv,
                securityContext: { ...confined, runAsUser: 65534, runAsNonRoot: true },
                volumeMounts: policyDirs.map(d => ({ name: d.name, mountPath: `/host${d.path}`, readOnly: true })),
                readinessProbe: {
                  exec: { command: ["/bin/sh", "-c", policyScript, "host-policy", "check"] },
                  periodSeconds: 300,
                  timeoutSeconds: 60,
                  failureThreshold: 1,
                },
              },
            ],
            volumes: policyDirs.map(d => ({ name: d.name, hostPath: { path: d.path, type: d.type } })),
          },
        },
      },
    });
  }
}
