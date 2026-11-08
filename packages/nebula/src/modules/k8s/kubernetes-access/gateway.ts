import { createHash } from "node:crypto";
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { stringify } from "yaml";
import { BaseConstruct } from "../../../core";
import { EnvoyJwtProxy } from "../envoy/jwt-proxy";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "./identity";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS } from "./workload-identity";
export const KUBERNETES_OIDC_ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.40.1@sha256:713bb146f1a7c97ebc70e13d259f77ff36f2c5d00f3145677816af5af9bd1530";
/** Uses the existing ingress and public TLS issuer; creates no load balancer,
 * cloud role, certificate credential or identity-provider client secret. */
export interface KubernetesOidcGatewayConfig extends KubernetesOidcIdentityConfig {
  /** Override labels when migrating an existing gateway with immutable selectors. */
  podLabels?: Record<string, string>;
  image?: string;
}
export class KubernetesOidcGateway extends BaseConstruct<KubernetesOidcGatewayConfig> {
  public readonly identity: KubernetesOidcIdentity;
  public readonly resources: ApiObject[] = [];
  constructor(scope: Construct, id: string, config: KubernetesOidcGatewayConfig) {
    super(scope, id, config);
    const c = this.config;
    this.identity = new KubernetesOidcIdentity(c);
    const name = `kubernetes-oidc-${c.cluster}`;
    const labels = c.podLabels ?? { "app.kubernetes.io/name": "kubernetes-oidc-access", "nebula.io/target-cluster": c.cluster };
    const metadata = (n = name) => ({ name: n, namespace: c.namespace, labels });
    const bootstrap = new EnvoyJwtProxy({
      issuers: { workforce: c.workforce, ...(c.workload ? { workload: c.workload } : {}) },
      backend: { ...c.backend, caFile: "/etc/kubernetes-ca/ca.crt" },
      maxTokenLifetimeSeconds: KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS,
    }).bootstrap;
    const envoyConfig = stringify(bootstrap);
    this.resources.push(new ApiObject(this, `${name}-config`, { apiVersion: "v1", kind: "ConfigMap", metadata: metadata(), data: { "envoy.yaml": envoyConfig } }));
    this.resources.push(new ApiObject(this, `${name}-deployment`, {
      apiVersion: "apps/v1", kind: "Deployment", metadata: metadata(), spec: {
        replicas: 2, selector: { matchLabels: labels }, strategy: { rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        template: {
          metadata: { labels, annotations: { "checksum/config": createHash("sha256").update(envoyConfig).digest("hex") } }, spec: {
            automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
            containers: [{
              name: "envoy", image: c.image ?? KUBERNETES_OIDC_ENVOY_IMAGE,
              args: ["-c", "/etc/envoy/envoy.yaml", "--disable-hot-restart", "--log-level", "warn"],
              ports: [{ name: "http", containerPort: 8080 }],
              readinessProbe: { tcpSocket: { port: "http" } }, livenessProbe: { tcpSocket: { port: "http" } },
              resources: { requests: { cpu: "25m", memory: "64Mi" }, limits: { memory: "256Mi" } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              volumeMounts: [{ name: "config", mountPath: "/etc/envoy", readOnly: true }, { name: "backend-ca", mountPath: "/etc/kubernetes-ca", readOnly: true }],
            }],
            volumes: [{ name: "config", configMap: { name } },
            { name: "backend-ca", secret: { secretName: c.backend.caSecret.name, items: [{ key: c.backend.caSecret.key, path: "ca.crt" }] } }],
            affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { labelSelector: { matchLabels: labels }, topologyKey: "kubernetes.io/hostname" } }] } },
          }
        },
      }
    }));
    this.resources.push(new ApiObject(this, `${name}-service`, {
      apiVersion: "v1", kind: "Service", metadata: metadata(), spec: {
        type: "ClusterIP", selector: labels, ports: [{ name: "http", port: 8080, targetPort: "http" }],
      }
    }));
    this.resources.push(new ApiObject(this, `${name}-ingress`, {
      apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: {
        ...metadata(), annotations: {
          "cert-manager.io/cluster-issuer": c.clusterIssuer,
          "external-dns.alpha.kubernetes.io/hostname": c.hostname,
          "nginx.ingress.kubernetes.io/proxy-read-timeout": "600", "nginx.ingress.kubernetes.io/proxy-send-timeout": "600",
          "nginx.ingress.kubernetes.io/proxy-buffering": "off", "nginx.ingress.kubernetes.io/ssl-redirect": "true"
        },
      }, spec: {
        ingressClassName: c.ingressClassName, tls: [{ hosts: [c.hostname], secretName: `${name}-tls` }],
        rules: [{ host: c.hostname, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { name: "http" } } } }] } }],
      }
    }));
    this.resources.push(new ApiObject(this, `${name}-pdb`, { apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: metadata(), spec: { minAvailable: 1, selector: { matchLabels: labels } } }));
  }
}
