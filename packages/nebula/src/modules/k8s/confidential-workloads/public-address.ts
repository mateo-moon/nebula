import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { BaseConstruct } from "../../../core/base-construct";
import { isDigestImage } from "../confidential-guests/types";
import { publicConfig } from "../trustee/validation";
import { validatePublicAddressConfig } from "./public-address-runtime";

export interface ConfidentialPublicAddressConfig {
  name: string; namespace: string; nodeName: string;
  /** Existing host-owned IPv4, exclusively allocated to this workload. */
  ipAddress: string;
  workloadName: string; profile: string;
  /** Allowed private IPv4 range of the final Pod, e.g. 10.244.0.0/16. */
  podCidr: string;
  /** Pinned host utility image with Node >=24 and nft. The workload agent
   * image already supplies these; this process is ordinary host plumbing. */
  image: string;
}

/** Allocate an existing public IP to the current final guest using 1:1 native
 * host NAT. No confidential Pod uses hostNetwork. TNG's 8443/8445 listeners
 * remain authenticated system ports; applications cannot bind those ports.
 * Other TCP/UDP ports are forwarded without an application port allowlist. */
export class ConfidentialPublicAddress extends BaseConstruct<ConfidentialPublicAddressConfig> {
  readonly tableName: string;
  constructor(scope: Construct, id: string, config: ConfidentialPublicAddressConfig) {
    super(scope, id, publicConfig("ConfidentialPublicAddress", config));
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(config.name) || !isDigestImage(config.image) ||
        Object.keys(config).sort().join() !== "image,ipAddress,name,namespace,nodeName,podCidr,profile,workloadName") throw new TypeError("Invalid confidential public address configuration");
    this.tableName = "nebula_public_" + createHash("sha256").update(`${config.namespace}/${config.name}/${config.ipAddress}`).digest("hex").slice(0, 16);
    const runtime = { namespace: config.namespace, nodeName: config.nodeName, workloadName: config.workloadName,
      profile: config.profile, ipAddress: config.ipAddress, podCidr: config.podCidr, table: this.tableName };
    validatePublicAddressConfig(runtime);
    const metadata = { name: config.name, namespace: config.namespace };
    new ApiObject(this, "service-account", { apiVersion: "v1", kind: "ServiceAccount", metadata, automountServiceAccountToken: false });
    new ApiObject(this, "role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata,
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }] });
    new ApiObject(this, "role-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata,
      subjects: [{ kind: "ServiceAccount", name: config.name, namespace: config.namespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: config.name } });
    new ApiObject(this, "runtime", { apiVersion: "v1", kind: "ConfigMap", metadata,
      data: { "runtime.ts": readFileSync(new URL("./public-address-runtime.ts", import.meta.url), "utf8") +
        '\nrunPublicAddress(JSON.parse(process.argv[2] ?? "null")).catch(() => { console.error("Confidential public address routing stopped"); process.exitCode = 1; });\n' } });
    new ApiObject(this, "deployment", { apiVersion: "apps/v1", kind: "Deployment", metadata,
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: config.name } },
        template: { metadata: { labels: { app: config.name } }, spec: {
          nodeName: config.nodeName, hostNetwork: true, dnsPolicy: "ClusterFirstWithHostNet", serviceAccountName: config.name,
          automountServiceAccountToken: false, enableServiceLinks: false, terminationGracePeriodSeconds: 20,
          containers: [{ name: "routing", image: config.image, command: ["node", "--disable-sigusr1", "/app/public-address/runtime.ts"], args: [JSON.stringify(runtime)],
            securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] } },
            resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
            volumeMounts: [{ name: "runtime", mountPath: "/app/public-address", readOnly: true },
              { name: "credentials", mountPath: "/run/kubernetes", readOnly: true }, { name: "state", mountPath: "/run/public-address" }],
            readinessProbe: { exec: { command: ["node", "-e", "const s=JSON.parse(require('fs').readFileSync('/run/public-address/state.json'));process.exit(Date.now()-s.checkedAt<15000?0:1)"] }, periodSeconds: 5 },
          }], volumes: [{ name: "runtime", configMap: { name: config.name } },
            { name: "credentials", projected: { sources: [{ serviceAccountToken: { path: "token", expirationSeconds: 600 } },
              { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } }] } },
            { name: "state", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } }],
        } } } });
    new ApiObject(this, "application-network", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata,
      spec: { podSelector: { matchLabels: { "confidential.nebula.dev/workload": config.workloadName,
        "confidential.nebula.dev/profile": config.profile } }, policyTypes: ["Ingress", "Egress"], ingress: [{}], egress: [{}] } });
  }
}
