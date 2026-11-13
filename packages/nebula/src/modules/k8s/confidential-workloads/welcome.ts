import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { BaseConstruct } from "../../../core/base-construct";
import { isDigestImage } from "../confidential-guests/types";
import type { TrusteeSnpIdentity } from "../trustee/policies";
import { publicConfig } from "../trustee/validation";

export interface ConfidentialWelcomeReference extends Omit<TrusteeSnpIdentity, "chipId"> {
  releaseUrl?: string;
}

export interface ConfidentialWelcomeConfig {
  name: string;
  namespace: string;
  hostname: string;
  /** Actual guest HTTPS origin. Never put a token or user information here. */
  portalUrl: string;
  /** Public comparison values, not a replacement for independently approved policy. */
  reference?: ConfidentialWelcomeReference;
  image?: string;
  ingressClassName?: string;
  ingressNamespace?: string;
  clusterIssuer?: string;
}

// Native TypeScript and bounded public-certificate fetching need no custom image.
const NODE_IMAGE = "docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"; // 24-bookworm-slim
const label = (value: string) => typeof value === "string" && /^[a-z][a-z0-9-]{0,38}$/.test(value);
const hostname = (value: string) => typeof value === "string" && value.length <= 253 &&
  value.split(".").length > 1 && value.split(".").every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));

function httpsUrl(value: string, originOnly: boolean): URL {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) throw new TypeError("Invalid welcome HTTPS URL");
  const url = new URL(value);
  if (url.href.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      originOnly && url.pathname !== "/") throw new TypeError("Welcome URLs require public HTTPS without credentials, queries or fragments");
  return url;
}

function reference(value: ConfidentialWelcomeReference): ConfidentialWelcomeReference {
  if (!value || Object.keys(value).some(key => !["measurement", "initDataSha256", "minimumReportedTcb", "releaseUrl"].includes(key)) ||
      !/^[a-f0-9]{96}$/.test(value.measurement) || !/^[a-f0-9]{64}$/.test(value.initDataSha256)) {
    throw new TypeError("Welcome reference requires explicit SNP measurement and native policy hashes");
  }
  const tcb = value.minimumReportedTcb;
  if (!tcb || Object.keys(tcb).sort().join() !== "bootloader,microcode,snp,tee" ||
      Object.values(tcb).some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new TypeError("Welcome reference requires all four explicit TCB bytes");
  }
  return { measurement: value.measurement, initDataSha256: value.initDataSha256,
    minimumReportedTcb: { bootloader: tcb.bootloader, tee: tcb.tee, snp: tcb.snp, microcode: tcb.microcode },
    ...(value.releaseUrl === undefined ? {} : { releaseUrl: httpsUrl(value.releaseUrl, false).href }) };
}

/** Ordinary HTTPS onboarding only. The guest's attestation, certificate check
 * and owner authentication stay at the original portal. No secret is accepted
 * here; its fixed public-data relay never forwards caller credentials. */
export class ConfidentialWelcome extends BaseConstruct<ConfidentialWelcomeConfig> {
  readonly url: string;
  readonly deployment: ApiObject;

  constructor(scope: Construct, id: string, config: ConfidentialWelcomeConfig) {
    super(scope, id, publicConfig("ConfidentialWelcome", config));
    const allowed = ["name", "namespace", "hostname", "portalUrl", "reference", "image", "ingressClassName", "ingressNamespace", "clusterIssuer"];
    const image = config.image ?? NODE_IMAGE, ingressClassName = config.ingressClassName ?? "nginx";
    const ingressNamespace = config.ingressNamespace ?? "ingress-nginx", clusterIssuer = config.clusterIssuer ?? "letsencrypt-prod";
    if (Object.keys(config).some(key => !allowed.includes(key)) ||
        ![config.name, config.namespace, ingressClassName, ingressNamespace, clusterIssuer].every(label) ||
        !hostname(config.hostname) || !isDigestImage(image)) throw new TypeError("Invalid confidential welcome deployment configuration");
    const portal = httpsUrl(config.portalUrl, true);
    const safe = { portalUrl: portal.href, ...(config.reference === undefined ? {} : { reference: reference(config.reference) }) };
    const data: Record<string, string> = { "config.json": JSON.stringify(safe) };
    for (const file of ["server.mts", "index.html", "style.css", "client.ts"]) {
      data[file] = readFileSync(new URL(`./welcome/${file}`, import.meta.url), "utf8");
    }
    const name = config.name, namespace = config.namespace, labels = { "app.kubernetes.io/name": name,
      "app.kubernetes.io/component": "confidential-welcome" };
    const metadata = { name, namespace };
    this.url = `https://${config.hostname}/`;
    new ApiObject(this, "site", { apiVersion: "v1", kind: "ConfigMap", metadata, data });
    this.deployment = new ApiObject(this, "deployment", { apiVersion: "apps/v1", kind: "Deployment", metadata,
      spec: { replicas: 1, selector: { matchLabels: labels }, template: {
        metadata: { labels, annotations: { "checksum/site": createHash("sha256").update(JSON.stringify(data)).digest("hex") } },
        spec: { automountServiceAccountToken: false, enableServiceLinks: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "welcome", image, command: ["node", "--disable-sigusr1", "/app/server.mts"],
            ports: [{ name: "http", containerPort: 8080 }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "5m", memory: "32Mi" }, limits: { cpu: "100m", memory: "128Mi" } },
            readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 5 },
            livenessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 20 },
            volumeMounts: [{ name: "site", mountPath: "/app", readOnly: true }, { name: "tmp", mountPath: "/tmp" }],
          }], volumes: [{ name: "site", configMap: { name, defaultMode: 0o444 } }, { name: "tmp", emptyDir: { sizeLimit: "8Mi" } }],
        },
      } },
    });
    new ApiObject(this, "service", { apiVersion: "v1", kind: "Service", metadata,
      spec: { selector: labels, ports: [{ name: "http", port: 80, targetPort: "http" }] } });
    new ApiObject(this, "ingress", { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { ...metadata, annotations: {
      "cert-manager.io/cluster-issuer": clusterIssuer, "external-dns.alpha.kubernetes.io/hostname": config.hostname,
      "nginx.ingress.kubernetes.io/ssl-redirect": "true", "nginx.ingress.kubernetes.io/proxy-body-size": "1k",
    } }, spec: { ingressClassName, tls: [{ hosts: [config.hostname], secretName: `${name}-tls` }],
      rules: [{ host: config.hostname, http: { paths: [{ path: "/", pathType: "Prefix",
        backend: { service: { name, port: { number: 80 } } } }] } }],
    } });
    const address = portal.hostname.replace(/^\[|\]$/g, ""), version = isIP(address);
    new ApiObject(this, "network", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata, spec: {
      podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": ingressNamespace } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx", "app.kubernetes.io/component": "controller" } } }],
      ports: [{ protocol: "TCP", port: 8080 }] }],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
          podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        { ...(version ? { to: [{ ipBlock: { cidr: `${address}/${version === 4 ? 32 : 128}` } }] } : {}),
          ports: [{ protocol: "TCP", port: Number(portal.port || 443) }] },
      ],
    } });
  }
}
