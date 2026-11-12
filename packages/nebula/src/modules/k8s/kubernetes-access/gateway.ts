import { createHash } from "node:crypto";
import type { ApiObject } from "cdk8s";
import {
  IntOrString, KubeConfigMap, KubeDeployment, KubeIngress, KubePodDisruptionBudget, KubeService, Quantity,
} from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { stringify } from "yaml";
import { BaseConstruct, confinedContainer, unprivilegedPod } from "../../../core";
import { isDnsName } from "../../../utils/oidc";
import { EnvoyJwtProxy } from "../envoy/jwt-proxy";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "./identity";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS } from "./workload-identity";

export const KUBERNETES_OIDC_ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.40.1@sha256:713bb146f1a7c97ebc70e13d259f77ff36f2c5d00f3145677816af5af9bd1530";

/** Uses the existing ingress and public TLS issuer; creates no load balancer,
 * cloud role, certificate credential or identity-provider client secret. */
export interface KubernetesOidcGatewayConfig extends KubernetesOidcIdentityConfig {
  namespace: string;
  ingressClassName: string;
  clusterIssuer: string;
  backend: { host: string; port: number; serverName: string; caSecret: { name: string; key: string } };
  /** Labels shared by the Deployment, Service and disruption budget selectors. */
  podLabels?: Record<string, string>;
  /** Maximum duration of a proxied API stream; defaults to 600 seconds. */
  maxStreamDurationSeconds?: number;
  image?: string;
}

const caDirectory = "/etc/kubernetes-ca";
const http = IntOrString.fromString("http");

export class KubernetesOidcGateway extends BaseConstruct<KubernetesOidcGatewayConfig> {
  public readonly identity: KubernetesOidcIdentity;
  public readonly resources: ApiObject[];

  constructor(scope: Construct, id: string, config: KubernetesOidcGatewayConfig) {
    super(scope, id, config);
    const c = this.config;
    this.identity = new KubernetesOidcIdentity(c);
    const { backend } = c;
    if (!isDnsName(backend.host) || !isDnsName(backend.serverName) ||
        !Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535)
      throw new Error("The gateway requires a TLS backend with an exact DNS name and port");

    const name = `kubernetes-oidc-${c.cluster}`;
    const labels = c.podLabels ?? { "app.kubernetes.io/name": "kubernetes-oidc-access", "nebula.io/target-cluster": c.cluster };
    const metadata = () => ({ name, namespace: c.namespace, labels });
    const streamSeconds = String(c.maxStreamDurationSeconds ?? KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
    const envoyConfig = stringify(new EnvoyJwtProxy({
      issuers: { workforce: c.workforce, ...(c.workload ? { workload: c.workload } : {}) },
      backend: { ...backend, caFile: `${caDirectory}/ca.crt` },
      maxTokenLifetimeSeconds: KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS,
      maxStreamDurationSeconds: c.maxStreamDurationSeconds,
    }).bootstrap);

    this.resources = [
      new KubeConfigMap(this, `${name}-config`, { metadata: metadata(), data: { "envoy.yaml": envoyConfig } }),
      new KubeDeployment(this, `${name}-deployment`, {
        metadata: metadata(),
        spec: {
          replicas: 2,
          selector: { matchLabels: labels },
          strategy: { rollingUpdate: { maxUnavailable: IntOrString.fromNumber(0), maxSurge: IntOrString.fromNumber(1) } },
          template: {
            metadata: { labels, annotations: { "checksum/config": createHash("sha256").update(envoyConfig).digest("hex") } },
            spec: {
              automountServiceAccountToken: false,
              securityContext: unprivilegedPod(),
              containers: [{
                name: "envoy", image: c.image ?? KUBERNETES_OIDC_ENVOY_IMAGE,
                args: ["-c", "/etc/envoy/envoy.yaml", "--disable-hot-restart", "--log-level", "warn"],
                ports: [{ name: "http", containerPort: 8080 }],
                readinessProbe: { tcpSocket: { port: http } },
                livenessProbe: { tcpSocket: { port: http } },
                resources: {
                  requests: { cpu: Quantity.fromString("25m"), memory: Quantity.fromString("64Mi") },
                  limits: { memory: Quantity.fromString("256Mi") },
                },
                securityContext: confinedContainer,
                volumeMounts: [
                  { name: "config", mountPath: "/etc/envoy", readOnly: true },
                  { name: "backend-ca", mountPath: caDirectory, readOnly: true },
                ],
              }],
              volumes: [
                { name: "config", configMap: { name } },
                { name: "backend-ca", secret: { secretName: backend.caSecret.name, items: [{ key: backend.caSecret.key, path: "ca.crt" }] } },
              ],
              affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{
                weight: 100, podAffinityTerm: { labelSelector: { matchLabels: labels }, topologyKey: "kubernetes.io/hostname" },
              }] } },
            },
          },
        },
      }),
      new KubeService(this, `${name}-service`, {
        metadata: metadata(),
        spec: { type: "ClusterIP", selector: labels, ports: [{ name: "http", port: 8080, targetPort: http }] },
      }),
      new KubeIngress(this, `${name}-ingress`, {
        metadata: {
          ...metadata(),
          annotations: {
            "cert-manager.io/cluster-issuer": c.clusterIssuer,
            "external-dns.alpha.kubernetes.io/hostname": c.hostname,
            "nginx.ingress.kubernetes.io/proxy-read-timeout": streamSeconds,
            "nginx.ingress.kubernetes.io/proxy-send-timeout": streamSeconds,
            "nginx.ingress.kubernetes.io/proxy-buffering": "off",
            "nginx.ingress.kubernetes.io/ssl-redirect": "true",
          },
        },
        spec: {
          ingressClassName: c.ingressClassName,
          tls: [{ hosts: [c.hostname], secretName: `${name}-tls` }],
          rules: [{ host: c.hostname, http: { paths: [{
            path: "/", pathType: "Prefix", backend: { service: { name, port: { name: "http" } } },
          }] } }],
        },
      }),
      new KubePodDisruptionBudget(this, `${name}-pdb`, {
        metadata: metadata(),
        spec: { minAvailable: IntOrString.fromNumber(1), selector: { matchLabels: labels } },
      }),
    ];
  }
}
