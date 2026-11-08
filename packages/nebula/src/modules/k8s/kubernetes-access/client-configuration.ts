import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { validateOidcHttpsUrl } from "../../../utils/oidc";

export interface KubernetesOidcNativeClientBinding {
  issuer: string;
  clientId: string;
}

export interface KubernetesOidcClientConfigurationConfig extends KubernetesOidcNativeClientBinding {
  name: string;
  namespace: string;
  /** Explicitly public native/desktop registration, never a confidential web client. */
  applicationType: "native";
  /** Omit when an operator populates data.client_secret separately in Kubernetes. */
  clientSecret?: string;
}

function validateBinding(binding: KubernetesOidcNativeClientBinding): void {
  validateOidcHttpsUrl(binding.issuer);
  if (!binding.clientId || /[\s*\u0000-\u001f\u007f]/.test(binding.clientId))
    throw new Error("Native OIDC configuration requires one exact client ID");
}

function validateClientSecret(value: string): void {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Native OIDC application configuration requires a non-empty client secret");
}

/** Converts only registration settings to the existing local login adapter's input.
 * User tokens, cache data and cleanup/expiry metadata never belong in this map. */
export function kubernetesOidcNativeClientInput(
  binding: KubernetesOidcNativeClientBinding,
  data: Readonly<Record<string, string>>,
): { issuer: string; client_id: string; client_secret: string } {
  validateBinding(binding);
  if (Object.keys(data).sort().join(",") !== "client_id,client_secret,issuer" ||
      data.issuer !== binding.issuer || data.client_id !== binding.clientId)
    throw new Error("Native OIDC ConfigMap must contain only the matching issuer, client_id and client_secret");
  validateClientSecret(data.client_secret!);
  return { issuer: binding.issuer, client_id: binding.clientId, client_secret: data.client_secret! };
}

/** Durable public-client registration configuration; confers no user or workload identity. */
export class KubernetesOidcClientConfiguration extends BaseConstruct<KubernetesOidcClientConfigurationConfig> {
  public readonly configMap: ApiObject;

  constructor(scope: Construct, id: string, config: KubernetesOidcClientConfigurationConfig) {
    super(scope, id, config);
    const c = this.config;
    if (c.applicationType !== "native") throw new Error("ConfigMap OIDC registration storage is limited to public native applications");
    const allowed = new Set(["name", "namespace", "applicationType", "issuer", "clientId", "clientSecret"]);
    if (Object.keys(c).some(key => !allowed.has(key)))
      throw new Error("OIDC client configuration must not contain user tokens or other settings");
    for (const [value, limit] of [[c.name, 253], [c.namespace, 63]] as const) {
      if (value.length > limit || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value) ||
          (limit === 63 && value.includes(".")))
        throw new Error("Exact Kubernetes name and namespace are required for OIDC client configuration");
    }
    validateBinding(c);
    if (c.clientSecret !== undefined) validateClientSecret(c.clientSecret);
    this.configMap = new ApiObject(this, "configuration", {
      apiVersion: "v1", kind: "ConfigMap",
      metadata: { name: c.name, namespace: c.namespace, annotations: {
        "nebula.io/oauth-application-type": "native",
        // Own only supplied map keys. An externally populated client_secret key
        // survives subsequent GitOps server-side applies that omit that key.
        "argocd.argoproj.io/sync-options": "ServerSideApply=true",
      } },
      data: { issuer: c.issuer, client_id: c.clientId, ...(c.clientSecret === undefined ? {} : { client_secret: c.clientSecret }) },
    });
  }
}
