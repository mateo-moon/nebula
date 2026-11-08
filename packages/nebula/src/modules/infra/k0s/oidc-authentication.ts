import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { stringify } from "yaml";
import { BaseConstruct } from "../../../core";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "../../k8s/kubernetes-access/identity";

const authDirectory = "/etc/kubernetes-oidc";
const authFile = `${authDirectory}/authentication.yaml`;
export interface K0sOidcIsolation {
  /** Explicit platform-owned selectors; never inferred from a cloud provider. */
  controlPlaneLabels: Record<string, string>;
  gatewayLabels: Record<string, string>;
  platformNamespaces: readonly string[];
}
export interface K0sOidcAuthenticationConfig {
  identity: KubernetesOidcIdentityConfig;
  /** Deployment-owned RBAC policy, installed through k0s's manifest applier. */
  bootstrapManifests?: readonly object[];
  /** Omit while preparing authentication. Enabling isolates the raw system API. */
  isolation?: K0sOidcIsolation;
}
/** Shared API options for hosted and standalone control-plane modules. */
export interface K0sApiOptions {
  /** Structured OIDC policy. Standalone bootstrap changes require host maintenance. */
  authentication?: K0sOidcAuthenticationConfig;
  apiExtraArgs?: Record<string, string>;
  /** Ordered arguments, including repeated service-account issuers. */
  apiRawArgs?: string[];
}
/** Provider-independent k0s authentication composition. Hosted controllers use
 * public ConfigMaps; standalone controllers use bootstrap files. Neither path
 * copies a client private key or changes worker bootstrap. */
export class K0sOidcAuthentication extends BaseConstruct<K0sOidcAuthenticationConfig> {
  public readonly identity: KubernetesOidcIdentity;
  private hostedConfig?: ReturnType<K0sOidcAuthentication["renderHosted"]>;
  constructor(scope: Construct, id: string, config: K0sOidcAuthenticationConfig) {
    super(scope, id, config);
    this.identity = new KubernetesOidcIdentity(this.config.identity);
    this.identity.validate(Boolean(this.config.isolation));
    if (this.config.isolation && (!Object.keys(this.config.isolation.controlPlaneLabels).length || !Object.keys(this.config.isolation.gatewayLabels).length))
      throw new Error("Raw API isolation requires explicit control-plane and gateway selectors");
  }
  public static validateControlPlane(config: K0sOidcAuthenticationConfig | undefined, context: { namespace: string; k8sVersion: string }): void {
    if (!config) return;
    if (config.identity.namespace !== context.namespace) throw new Error("OIDC configuration must use the control plane's hosting namespace");
    const version = /^v?(\d+)\.(\d+)\./.exec(context.k8sVersion);
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 34))
      throw new Error("Structured OIDC authentication requires Kubernetes 1.34 or later");
  }
  public api(extraArgs?: Record<string, string>, rawArgs?: readonly string[]) {
    const args = Object.fromEntries(Object.entries(extraArgs ?? {}).filter(([flag]) => !flag.startsWith("oidc-")));
    args["anonymous-auth"] = "false";
    args["authentication-config"] = authFile;
    // Repeated service-account issuers remain intact. Legacy OIDC/duplicate auth
    // flags cannot override the structured policy later in the argument list.
    const raw: string[] = [];
    for (let i = 0; i < (rawArgs?.length ?? 0); i++) {
      const arg = rawArgs![i]!;
      if (/^--?(oidc-[^=]+|authentication-config|anonymous-auth)(=|$)/.test(arg)) {
        if (!arg.includes("=") && rawArgs![i + 1] && !rawArgs![i + 1]!.startsWith("-")) i++;
      } else raw.push(arg);
    }
    return { extraArgs: args, ...(raw.length ? { rawArgs: raw } : {}) };
  }
  private get manifests(): string { return (this.config.bootstrapManifests ?? []).map(o => stringify(o)).join("---\n"); }
  public hosted() { return this.hostedConfig ??= this.renderHosted(); }
  private renderHosted() {
    const c = this.config.identity;
    const cm = `oidc-${c.cluster}-authentication`;
    new ApiObject(this, "authentication", {
      apiVersion: "v1", kind: "ConfigMap", metadata: { name: cm, namespace: c.namespace },
      data: { "authentication.yaml": stringify(this.identity.authenticationConfiguration()) }
    });
    new ApiObject(this, "rbac", { apiVersion: "v1", kind: "ConfigMap", metadata: { name: `${cm}-rbac`, namespace: c.namespace }, data: { "access.yaml": this.manifests } });
    const isolation = this.config.isolation;
    if (isolation) new ApiObject(this, "system-api-network", {
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
      metadata: { name: `system-api-${c.cluster}`, namespace: c.namespace }, spec: {
        podSelector: { matchLabels: isolation.controlPlaneLabels }, policyTypes: ["Ingress"], ingress: [
          { ports: [{ protocol: "TCP", port: 1, endPort: 30442 }, { protocol: "TCP", port: 30444, endPort: 65535 }, { protocol: "UDP", port: 1, endPort: 65535 }] },
          {
            from: [...c.systemSourceCidrs.map(cidr => ({ ipBlock: { cidr } })), { podSelector: { matchLabels: isolation.gatewayLabels } },
            ...isolation.platformNamespaces.map(name => ({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } } }))], ports: [{ protocol: "TCP", port: 30443 }]
          },
        ],
      }
    });
    return {
      mounts: [{ path: authDirectory, readOnly: true, configMap: { name: cm } }],
      manifests: [{ name: "oidc-access", configMap: { name: `${cm}-rbac` } }],
      patches: isolation ? [
        { target: { kind: "Service", component: "control-plane" }, patch: { type: "merge" as const, content: JSON.stringify({ spec: { loadBalancerSourceRanges: c.systemSourceCidrs, externalTrafficPolicy: "Local" } }) } },
        { target: { kind: "StatefulSet", component: "control-plane" }, patch: { type: "merge" as const, content: JSON.stringify({ spec: { template: { metadata: { labels: isolation.controlPlaneLabels } } } }) } },
      ] : [],
    };
  }
  public standalone() {
    const files = [
      { path: authFile, content: stringify(this.identity.authenticationConfiguration()), permissions: "0644" },
      { path: "/var/lib/k0s/manifests/oidc-access/access.yaml", content: this.manifests, permissions: "0644" },
    ];
    if (this.config.isolation) files.push(
      { path: `${authDirectory}/restrict-system-api.sh`, content: this.systemApiFirewall(), permissions: "0700" },
      { path: "/etc/systemd/system/kubernetes-system-api.service", permissions: "0644", content: `[Unit]\nDescription=Restrict raw Kubernetes API to cluster systems\nBefore=k0scontroller.service\nAfter=network-pre.target\n[Service]\nType=oneshot\nExecStart=${authDirectory}/restrict-system-api.sh\nRemainAfterExit=yes\n[Install]\nWantedBy=multi-user.target\n` },
    );
    return { files, preK0SCommands: this.config.isolation ? ["systemctl daemon-reload", "systemctl enable --now kubernetes-system-api.service"] : [] };
  }
  public systemApiFirewall(): string {
    const cidrs = this.config.identity.systemSourceCidrs;
    const rules = cidrs.map(cidr => `    ${cidr.includes(":") ? "ip6" : "ip"} saddr ${cidr} tcp dport 6443 accept`).join("\n");
    return `#!/bin/sh
set -eu
command -v nft >/dev/null || { apt-get update; apt-get install -y --no-install-recommends nftables; }
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
if nft list table inet kubernetes_system_api >/dev/null 2>&1; then
  echo 'delete table inet kubernetes_system_api' > "$rules"
fi
cat >> "$rules" <<'NFT'
table inet kubernetes_system_api {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "lo" tcp dport 6443 accept
${rules}
    tcp dport 6443 drop
  }
}
NFT
nft -c -f "$rules"
nft -f "$rules"
`;
  }

}
