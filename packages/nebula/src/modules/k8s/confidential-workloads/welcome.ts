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
  /** Literal public address routed to this stack's Service on ports 80/443. */
  ipAddress: string;
  acmeEmail: string;
  /** Existing retained filesystem PVC for Caddy's account and certificate state. */
  acmeClaimName: string;
  nodeSelector?: Record<string, string>;
  /** Explicit stack-owned listeners for TNG OHTTP or filtered public metadata. */
  publicOhttpRoutes?: { port: number; upstream: string }[];
  /** Actual guest HTTPS origin. Never put a token or user information here. */
  portalUrl: string;
  /** Optional same-cluster ConfidentialBrowser service for public certificate fetching only. */
  portalService?: { name: string; namespace: string };
  /** Public comparison values, not a replacement for independently approved policy. */
  reference?: ConfidentialWelcomeReference;
  image?: string;
  caddyImage?: string;
}

// Native TypeScript and bounded public-certificate fetching need no custom image.
const NODE_IMAGE = "docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"; // 24-bookworm-slim
const CADDY_IMAGE = "docker.io/library/caddy@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0"; // 2.11.9
const label = (value: string) => typeof value === "string" && /^[a-z][a-z0-9-]{0,38}$/.test(value);
const dnsName = (value: string) => typeof value === "string" && value.length <= 253 &&
  value.split(".").every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
const selectorPart = (value: string) => typeof value === "string" && value.length <= 63 && /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/.test(value);

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
    const allowed = ["name", "namespace", "ipAddress", "acmeEmail", "acmeClaimName", "nodeSelector", "publicOhttpRoutes", "portalUrl", "portalService", "reference", "image", "caddyImage"];
    const image = config.image ?? NODE_IMAGE, caddyImage = config.caddyImage ?? CADDY_IMAGE;
    if (Object.keys(config).some(key => !allowed.includes(key)) ||
        ![config.name, config.namespace].every(label) || !dnsName(config.acmeClaimName) ||
        typeof config.ipAddress !== "string" || !isIP(config.ipAddress) || config.ipAddress.includes("%") ||
        typeof config.acmeEmail !== "string" || config.acmeEmail.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(config.acmeEmail) ||
        !isDigestImage(image) || !isDigestImage(caddyImage)) throw new TypeError("Invalid confidential welcome deployment configuration");
    if (config.nodeSelector !== undefined && (!config.nodeSelector || typeof config.nodeSelector !== "object" || Array.isArray(config.nodeSelector) ||
        Object.entries(config.nodeSelector).some(([key, value]) => {
          const parts = key.split("/");
          return parts.length > 2 || !(parts.length === 1 ? selectorPart(parts[0]) && !!parts[0] : dnsName(parts[0]) && selectorPart(parts[1]) && !!parts[1]) || !selectorPart(value);
        }))) throw new TypeError("Invalid welcome node selector");
    if (config.publicOhttpRoutes !== undefined && (!Array.isArray(config.publicOhttpRoutes) || config.publicOhttpRoutes.length > 8)) {
      throw new TypeError("Welcome public routes require a bounded explicit list");
    }
    const portal = httpsUrl(config.portalUrl, true);
    const portalService = config.portalService;
    if (portalService !== undefined && (!portalService || Object.keys(portalService).sort().join() !== "name,namespace" ||
        [portalService.name, portalService.namespace].some(value => !dnsName(value) || value.length > 63 || value.includes(".")))) {
      throw new TypeError("Welcome portal service requires explicit Kubernetes service and namespace names");
    }
    const ports = new Set<number>([80, 443, 8080, 8081, 8443, Number(portal.port || 443)]);
    const routes = (config.publicOhttpRoutes ?? []).map(route => {
      if (!route || Object.keys(route).sort().join() !== "port,upstream" || !Number.isInteger(route.port) ||
          route.port < 1024 || route.port > 65535 || ports.has(route.port) || typeof route.upstream !== "string" || route.upstream.length > 2048) {
        throw new TypeError("Invalid or conflicting welcome public route");
      }
      const url = new URL(route.upstream), parts = url.hostname.split(".");
      if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
          parts.length !== 3 || parts[2] !== "svc" || parts.slice(0, 2).some(part => part.length > 63 || !dnsName(part)) ||
          !["8445", "8083"].includes(url.port) || route.upstream.trim() !== route.upstream || /[\x00-\x20\x7f]/.test(route.upstream)) {
        throw new TypeError("Welcome routes allow only fixed cluster TNG OHTTP8445 or filtered public metadata8083 origins");
      }
      ports.add(route.port);
      return { port: route.port, upstream: url.origin, namespace: parts[1],
        targetPort: Number(url.port) };
    });
    const safe = { portalUrl: portal.href, ...(config.reference === undefined ? {} : { reference: reference(config.reference) }) };
    const data: Record<string, string> = { "config.json": JSON.stringify({ ...safe,
      ...(portalService === undefined ? {} : { certificateOrigin: `https://${portalService.name}.${portalService.namespace}.svc:10443/` }) }) };
    const publicIp = isIP(config.ipAddress) === 6 ? new URL(`https://[${config.ipAddress}]/`).hostname.slice(1, -1) : config.ipAddress;
    const address = isIP(publicIp) === 6 ? `[${publicIp}]` : publicIp;
    this.url = `https://${address}/`;
    const tls = `  tls {
    issuer acme {
      dir https://acme-v02.api.letsencrypt.org/directory
      email ${JSON.stringify(config.acmeEmail)}
      profile shortlived
      disable_tlsalpn_challenge
    }
  }`;
    data.Caddyfile = `{
  admin off
  persist_config off
  auto_https disable_redirects
  http_port 8080
  https_port 8443
  default_sni ${JSON.stringify(publicIp)}
  storage file_system {
    root /data/caddy
  }
  log default {
    exclude http.log.access http.log.error http.handlers.reverse_proxy
  }
}
${this.url.slice(0, -1)} {
${tls}
  reverse_proxy 127.0.0.1:8081 {
    header_up -Authorization
    header_up -Cookie
  }
}
:8080 {
  redir ${this.url.slice(0, -1)}{uri} 308
}
${routes.map(route => `https://${address}:${route.port} {
${tls}
  reverse_proxy ${route.upstream}
}`).join("\n")}
`;
    for (const file of ["server.mts", "index.html", "style.css", "client.ts"]) {
      data[file] = readFileSync(new URL(`./welcome/${file}`, import.meta.url), "utf8");
    }
    const name = config.name, namespace = config.namespace, labels = { "app.kubernetes.io/name": name,
      "app.kubernetes.io/component": "confidential-welcome" };
    const metadata = { name, namespace };
    new ApiObject(this, "site", { apiVersion: "v1", kind: "ConfigMap", metadata, data });
    this.deployment = new ApiObject(this, "deployment", { apiVersion: "apps/v1", kind: "Deployment", metadata,
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels }, template: {
        metadata: { labels, annotations: { "checksum/site": createHash("sha256").update(JSON.stringify(data)).digest("hex") } },
        spec: { automountServiceAccountToken: false, enableServiceLinks: false,
          ...(config.nodeSelector === undefined ? {} : { nodeSelector: { ...config.nodeSelector } }),
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "welcome", image, command: ["node", "--disable-sigusr1", "/app/server.mts"],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "5m", memory: "32Mi" }, limits: { cpu: "100m", memory: "128Mi" } },
            readinessProbe: { exec: { command: ["node", "--disable-sigusr1", "-e", 'fetch("http://127.0.0.1:8081/healthz",{signal:AbortSignal.timeout(1500)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'] }, periodSeconds: 5, timeoutSeconds: 3 },
            livenessProbe: { exec: { command: ["node", "--disable-sigusr1", "-e", 'fetch("http://127.0.0.1:8081/healthz",{signal:AbortSignal.timeout(1500)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'] }, periodSeconds: 20, timeoutSeconds: 3 },
            volumeMounts: [{ name: "site", mountPath: "/app", readOnly: true }, { name: "tmp", mountPath: "/tmp" }],
          }, { name: "https", image: caddyImage, command: ["caddy", "run", "--config", "/app/Caddyfile", "--adapter", "caddyfile"],
            ports: [{ name: "http", containerPort: 8080 }, { name: "https", containerPort: 8443 },
              ...routes.map(route => ({ name: `public-${route.port}`, containerPort: route.port }))],
            env: [{ name: "XDG_DATA_HOME", value: "/data" }, { name: "XDG_CONFIG_HOME", value: "/tmp/caddy-config" }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "5m", memory: "32Mi" }, limits: { cpu: "100m", memory: "128Mi" } },
            readinessProbe: { httpGet: { path: "/healthz", scheme: "HTTPS", port: "https", httpHeaders: [{ name: "Host", value: address }] }, periodSeconds: 5 },
            livenessProbe: { tcpSocket: { port: "https" }, periodSeconds: 20 },
            volumeMounts: [{ name: "site", mountPath: "/app", readOnly: true }, { name: "acme-state", mountPath: "/data" }, { name: "tmp", mountPath: "/tmp" }],
          }], volumes: [{ name: "site", configMap: { name, defaultMode: 0o444 } }, { name: "tmp", emptyDir: { sizeLimit: "8Mi" } },
            { name: "acme-state", persistentVolumeClaim: { claimName: config.acmeClaimName } }],
        },
      } },
    });
    new ApiObject(this, "service", { apiVersion: "v1", kind: "Service", metadata,
      // HTTP-01 must reach Caddy before the first HTTPS readiness check can pass.
      spec: { selector: labels, externalIPs: [publicIp], publishNotReadyAddresses: true,
        ports: [{ name: "http", port: 80, targetPort: "http" }, { name: "https", port: 443, targetPort: "https" },
          ...routes.map(route => ({ name: `public-${route.port}`, port: route.port, targetPort: `public-${route.port}` }))] } });
    const portalAddress = portal.hostname.replace(/^\[|\]$/g, ""), version = isIP(portalAddress);
    new ApiObject(this, "network", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata, spec: {
      podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"],
      ingress: [{ ports: [{ protocol: "TCP", port: 8080 }, { protocol: "TCP", port: 8443 },
        ...routes.map(route => ({ protocol: "TCP", port: route.port }))] }],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
          podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        { ports: [{ protocol: "TCP", port: 443 }] },
        ...(portalService ? [{ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": portalService.namespace } },
          podSelector: { matchLabels: { "confidential.nebula.dev/browser": portalService.name } } }], ports: [{ protocol: "TCP", port: 10443 }] }]
          : Number(portal.port || 443) === 443 ? [] : [{ ...(version ? { to: [{ ipBlock: { cidr: `${portalAddress}/${version === 4 ? 32 : 128}` } }] } : {}),
            ports: [{ protocol: "TCP", port: Number(portal.port) }] }]),
        ...routes.map(route => ({ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": route.namespace } } }],
          ports: [{ protocol: "TCP", port: route.targetPort }] })),
      ],
    } });
  }
}
