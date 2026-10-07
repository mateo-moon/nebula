import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { resolveSecrets } from "../../../utils";

export interface OAuth2ProxyConfig {
  namespace: string;
  name: string;
  secretName: string;
  ingressName: string;
  image: string;
  provider: string;
  emailDomains: readonly string[];
  host: string;
  port: number;
  tlsSecretName: string;
  ingressClassName: string;
  credentials: { clientId: string; clientSecret: string; cookieSecret: string };
  annotations?: Record<string, string>;
  resources: { requests?: Record<string, string>; limits?: Record<string, string> };
}

/** External-auth endpoint and OAuth callback ingress; the protected ingress stays caller-owned. */
export class OAuth2Proxy extends Construct {
  public readonly authUrl: string;
  public readonly signInUrl: string;

  constructor(scope: Construct, id: string, config: OAuth2ProxyConfig) {
    super(scope, id);
    const { namespace, name, secretName, ingressName, port, host, annotations } = config;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OAuth2Proxy port must be between 1 and 65535");
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^[a-zA-Z0-9-]+$/.test(config.provider)) throw new Error("OAuth2Proxy host and provider must be plain names");
    if (!config.emailDomains.length || config.emailDomains.some(domain => !/^(\*|[a-zA-Z0-9.-]+)$/.test(domain))) throw new Error("OAuth2Proxy emailDomains must contain explicit domain names or *");
    this.authUrl = `http://${name}.${namespace}.svc.cluster.local:${port}/oauth2/auth`;
    this.signInUrl = `https://${host}/oauth2/start?rd=$escaped_request_uri`;
    const labels = { app: name };
    new ApiObject(this, "secret", {
      apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace, annotations }, type: "Opaque",
      stringData: resolveSecrets({ "client-id": config.credentials.clientId, "client-secret": config.credentials.clientSecret, "cookie-secret": config.credentials.cookieSecret }),
    });
    new ApiObject(this, "deployment", {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace, labels, annotations },
      spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{
        name, image: config.image,
        args: [
          `--provider=${config.provider}`, ...config.emailDomains.map(domain => `--email-domain=${domain}`),
          `--http-address=0.0.0.0:${port}`, "--reverse-proxy=true", "--cookie-secure=true",
          `--cookie-domain=${host}`, `--whitelist-domain=${host}`, `--redirect-url=https://${host}/oauth2/callback`,
          "--upstream=static://200", "--skip-provider-button=true", "--set-xauthrequest=true",
        ],
        env: [
          { name: "OAUTH2_PROXY_CLIENT_ID", valueFrom: { secretKeyRef: { name: secretName, key: "client-id" } } },
          { name: "OAUTH2_PROXY_CLIENT_SECRET", valueFrom: { secretKeyRef: { name: secretName, key: "client-secret" } } },
          { name: "OAUTH2_PROXY_COOKIE_SECRET", valueFrom: { secretKeyRef: { name: secretName, key: "cookie-secret" } } },
        ],
        ports: [{ name: "http", containerPort: port }],
        readinessProbe: { httpGet: { path: "/ping", port }, initialDelaySeconds: 5, periodSeconds: 10 },
        resources: config.resources,
      }] } } },
    });
    new ApiObject(this, "service", {
      apiVersion: "v1", kind: "Service", metadata: { name, namespace, annotations },
      spec: { selector: labels, ports: [{ name: "http", port, targetPort: port }] },
    });
    new ApiObject(this, "ingress", {
      apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: ingressName, namespace, annotations },
      spec: { ingressClassName: config.ingressClassName,
        rules: [{ host, http: { paths: [{ path: "/oauth2", pathType: "Prefix", backend: { service: { name, port: { number: port } } } }] } }],
        tls: [{ hosts: [host], secretName: config.tlsSecretName }],
      },
    });
  }
}
