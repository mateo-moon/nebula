import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { stringify } from "smol-toml";
import { BaseConstruct } from "../../../core/base-construct";
import { generateConfidentialWorkloadPolicy } from "../trustee/genpolicy";
import { publicConfig } from "../trustee/validation";
import { tngBootstrapScript } from "../trustee/tng-bootstrap";
import { measuredFragments } from "../envoy/measured-fragments";
import { INIT_DATA_ANNOTATION, type GuestPodManifest } from "../confidential-guests/measured";
import { isDigestImage } from "../confidential-guests/types";
import type { WorkloadRenderOptions, ConfidentialWorkloadSpec } from "./types";

export interface ConfidentialBrowserConfig {
  name: string; namespace: string; image: string; tngImage: string;
  nodeSelector: Readonly<Record<string, string>>;
  network: ConfidentialWorkloadSpec["network"];
  genpolicy?: WorkloadRenderOptions["genpolicy"];
}

/** A reusable preparation TEE, containing no Trustee and no persistent disk.
 * Its independently released native policy is verified before its UI or any
 * owner image/credential is sent. The final combined workload retains its own
 * unmodified Trustee, native genpolicy and owner enrollment. */
export function confidentialBrowserPlan(config: ConfidentialBrowserConfig) {
  if (![config.image, config.tngImage].every(isDigestImage) || !/^[a-z][a-z0-9-]{0,39}$/.test(config.name) ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(config.namespace)) throw new Error("Browser preparation requires pinned images and valid names");
  const tngConfig: any = { add_egress: [{ mapping: { in: { host: "0.0.0.0", port: 8445 }, out: { host: "127.0.0.1", port: 8446 } },
    attest: { aa_provider: "coco_asr", asr_addr: "http://127.0.0.1:8007", refresh_interval: 0 },
    ohttp: { key: { source: "file", path: "/run/browser/ohttp.pem" }, forward_client_ip: false,
      cors: { allow_origins: ["*"], allow_methods: ["GET", "POST", "OPTIONS"], allow_headers: ["*"], expose_headers: [], allow_credentials: false } } }] };
  const script = tngBootstrapScript(tngConfig).replace("exec tng launch", "while [ ! -s /run/browser/ohttp.pem ]; do sleep 1; done\nexec tng launch");
  const security = { runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
  const mounts = [{ name: "state", mountPath: "/run/browser" }, { name: "tmp", mountPath: "/tmp" }];
  const privateCommand = (command: string[]) => ["/bin/sh", "-ec", 'exec "$@" </dev/null >/dev/null 2>&1', "private-stdio", ...command];
  const pod: GuestPodManifest = { apiVersion: "v1", kind: "Pod", metadata: { name: config.name, namespace: config.namespace,
    labels: { "confidential.nebula.dev/browser": config.name }, annotations: {
      "io.katacontainers.config.hypervisor.default_memory": "4096",
      "io.katacontainers.config.hypervisor.default_vcpus": "2",
      "io.katacontainers.config.hypervisor.kernel_params": "agent.guest_components_procs=api-server-rest agent.guest_components_rest_api=all agent.aa_kbc_params=cc_kbc::http://127.0.0.1:8080",
    } }, spec: { runtimeClassName: "kata-qemu-snp", nodeSelector: config.nodeSelector,
    automountServiceAccountToken: false, enableServiceLinks: false, restartPolicy: "Never", terminationGracePeriodSeconds: 30,
    securityContext: { fsGroup: 10001, supplementalGroups: [0, 10001] },
    containers: [
      { name: "preparation", image: config.image, imagePullPolicy: "Always", command: privateCommand(["node", "/app/dist/service/main.mjs"]), args: ["serve"],
        env: [{ name: "HOME", value: "/tmp" }, { name: "OCICRYPT_KEYPROVIDER_CONFIG", value: "/etc/ocicrypt.conf" }],
        securityContext: security, volumeMounts: mounts },
      { name: "tng", image: config.tngImage, imagePullPolicy: "Always", command: privateCommand(["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', "tng"]),
        args: measuredFragments(Buffer.from(script).toString("base64")),
        env: [{ name: "RUST_LOG", value: "error" }, { name: "RUST_BACKTRACE", value: "0" }, { name: "HOME", value: "/tmp" }],
        securityContext: security, volumeMounts: [{ name: "state", mountPath: "/run/browser", readOnly: true }, { name: "tng-tmp", mountPath: "/tmp" }] },
    ], volumes: ["state", "tmp", "tng-tmp"].map(name => ({ name, emptyDir: { medium: "Memory", sizeLimit: name === "tmp" ? "512Mi" : "2Gi" } })),
  } };
  // CDH requires an explicit KBC configuration when loading its TOML. Public
  // helper image pulls need no key; the guest-local URL is never contacted for
  // bootstrap. Keeping it local prevents an external bootstrap Trustee.
  const generated = generateConfidentialWorkloadPolicy(pod, {
    "aa.toml": stringify({ token_configs: { kbs: { url: "http://127.0.0.1:8080" } }, log: { level: "off" } }),
    "cdh.toml": stringify({ kbc: { name: "cc_kbc", url: "http://127.0.0.1:8080" }, log: { level: "off" },
      image: { kbc: "cc_kbc", kbs_uri: "http://127.0.0.1:8080", max_concurrent_layer_downloads_per_image: 1 } }),
  },
    { network: config.network, genpolicy: config.genpolicy, k8sDistribution: "k0s", ociVersion: "1.3.0" });
  return { pod: { ...pod, metadata: { ...pod.metadata, annotations: { ...pod.metadata!.annotations, [INIT_DATA_ANNOTATION]: generated.ccInitData } } },
    initDataSha256: generated.initDataSha256 };
}

export class ConfidentialBrowser extends BaseConstruct<ConfidentialBrowserConfig> {
  readonly initDataSha256: string;
  constructor(scope: Construct, id: string, config: ConfidentialBrowserConfig) {
    super(scope, id, publicConfig("ConfidentialBrowser", config));
    const plan = confidentialBrowserPlan(config);
    this.initDataSha256 = plan.initDataSha256;
    // A named retained Pod is deliberate: an enrolled preparation VM is never
    // silently replaced by a Deployment rollout or Argo pruning.
    const metadata = { ...plan.pod.metadata, name: config.name, generateName: undefined,
      annotations: { ...plan.pod.metadata.annotations, "argocd.argoproj.io/sync-wave": "-1", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } };
    new ApiObject(this, "pod", { ...plan.pod, apiVersion: "v1", kind: "Pod", metadata });
    for (const [suffix, port] of [["", 8445], ["-invitation", 8089]] as const) new ApiObject(this, `service${suffix}`, {
      apiVersion: "v1", kind: "Service", metadata: { name: config.name + suffix, namespace: config.namespace },
      spec: { selector: { "confidential.nebula.dev/browser": config.name }, ports: [{ name: "http", port, targetPort: port }] },
    });
    new ApiObject(this, "invitation-network", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
      metadata: { name: config.name, namespace: config.namespace }, spec: { podSelector: { matchLabels: { "confidential.nebula.dev/browser": config.name } },
        policyTypes: ["Ingress"], ingress: [{ ports: [{ protocol: "TCP", port: 8445 }] },
          { from: [{ podSelector: { matchLabels: { app: "confidential-operator" } } }], ports: [{ protocol: "TCP", port: 8089 }] }] } });
  }
}
