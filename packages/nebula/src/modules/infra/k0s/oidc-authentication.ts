import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { stringify } from "yaml";
import { BaseConstruct } from "../../../core";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "../../k8s/kubernetes-access/identity";

const authDirectory = "/etc/kubernetes-oidc";
const authFile = `${authDirectory}/authentication.yaml`;

export interface K0sOidcAuthenticationConfig {
  identity: KubernetesOidcIdentityConfig;
  /** Hosting namespace; inherited from the containing control plane. */
  namespace?: string;
  /** Caller-supplied Kubernetes manifests, installed by k0s's manifest applier. */
  bootstrapManifests?: readonly object[];
}

/** Shared API options for hosted and standalone control-plane modules. */
export interface K0sApiOptions {
  authentication?: K0sOidcAuthenticationConfig;
  apiExtraArgs?: Record<string, string>;
  /** Ordered arguments, including repeated service-account issuers. */
  apiRawArgs?: string[];
}

/** Composes structured authentication into hosted ConfigMaps or standalone
 * bootstrap files. Networking and access lifecycle belong to the caller. */
export class K0sOidcAuthentication extends BaseConstruct<K0sOidcAuthenticationConfig> {
  public readonly identity: KubernetesOidcIdentity;
  private hostedConfig?: ReturnType<K0sOidcAuthentication["renderHosted"]>;

  constructor(scope: Construct, id: string, config: K0sOidcAuthenticationConfig) {
    super(scope, id, config);
    this.identity = new KubernetesOidcIdentity(this.config.identity);
  }

  public static validateControlPlane(config: K0sOidcAuthenticationConfig | undefined, context: { namespace: string; k8sVersion: string }): void {
    if (!config) return;
    if (config.namespace && config.namespace !== context.namespace) throw new Error("OIDC configuration must use the control plane's hosting namespace");
    const version = /^v?(\d+)\.(\d+)\./.exec(context.k8sVersion);
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 34))
      throw new Error("Structured OIDC authentication requires Kubernetes 1.34 or later");
  }

  public api(extraArgs?: Record<string, string>, rawArgs?: readonly string[]) {
    const managed = /^(oidc-|authentication-config$|anonymous-auth$)/;
    for (const flag of [...Object.keys(extraArgs ?? {}), ...(rawArgs ?? []).map(arg => arg.replace(/^--?/, "").split("=")[0]!)]) {
      if (managed.test(flag)) throw new Error(`Configure OIDC through authentication instead of the kube-apiserver flag ${flag}`);
    }
    return {
      extraArgs: { ...extraArgs, "anonymous-auth": "false", "authentication-config": authFile },
      ...(rawArgs?.length ? { rawArgs: [...rawArgs] } : {}),
    };
  }

  private get manifests(): string { return (this.config.bootstrapManifests ?? []).map(o => stringify(o)).join("---\n"); }
  public hosted() { return this.hostedConfig ??= this.renderHosted(); }

  private renderHosted() {
    const c = this.config;
    const name = `oidc-${c.identity.cluster}-authentication`;
    const metadata = (name: string) => ({ name, namespace: c.namespace ?? "default" });
    new ApiObject(this, "authentication", {
      apiVersion: "v1", kind: "ConfigMap", metadata: metadata(name),
      data: { "authentication.yaml": stringify(this.identity.authenticationConfiguration()) }
    });
    if (c.bootstrapManifests?.length) new ApiObject(this, "rbac", {
      apiVersion: "v1", kind: "ConfigMap", metadata: metadata(`${name}-rbac`), data: { "access.yaml": this.manifests }
    });
    return {
      mounts: [{ path: authDirectory, readOnly: true, configMap: { name } }],
      ...(c.bootstrapManifests?.length ? { manifests: [{ name: "oidc-access", configMap: { name: `${name}-rbac` } }] } : {}),
    };
  }

  public standalone() {
    return {
      files: [
        { path: authFile, content: stringify(this.identity.authenticationConfiguration()), permissions: "0644" },
        ...(this.config.bootstrapManifests?.length ? [{ path: "/var/lib/k0s/manifests/oidc-access/access.yaml", content: this.manifests, permissions: "0644" }] : []),
      ],
    };
  }
}
