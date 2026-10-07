import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
  CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope,
  Composition, CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { KUBERNETES_OIDC_PUBLICATION_TEMPLATE } from "./template";

export { KUBERNETES_OIDC_PUBLICATION_TEMPLATE } from "./template";

export interface AwsKubernetesOidcPublicationConfig {
  /** Stable Kubernetes resource prefix. */
  name: string;
  /** Existing HTTPS S3 issuer origin. Changing an issuer requires a separate migration. */
  issuerUrl: string;
  bucketName: string;
  region: string;
  accountId: string;
  sourceSecretName: string;
  sourceSecretNamespace: string;
  sourceSecretKey?: string;
  /** Optional reachable HTTPS origin; otherwise use the kubeconfig's current context. */
  apiServerUrl?: string;
  /** Namespace of the derived mTLS Secret, readable by provider-http. */
  tlsSecretNamespace?: string;
  kubeProviderConfigName?: string;
  httpProviderConfigName?: string;
  awsProviderConfigName?: string;
  /** Explicit bootstrap only. Existing issuer buckets are observed and never recreated. */
  createBucket?: boolean;
  tags?: Record<string, string>;
}

/** Publishes only public service-account verification keys. It does not create
 * signing keys, change the API server, or alter any IAM trust relationships. */
export class AwsKubernetesOidcPublication extends Construct {
  public readonly xr: ApiObject;
  constructor(scope: Construct, id: string, config: AwsKubernetesOidcPublicationConfig) {
    super(scope, id);
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(config.name))
      throw new Error("OIDC publication name must be a DNS label of 3–40 characters");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucketName))
      throw new Error("OIDC publication bucket must be a DNS label of 3–63 characters");
    if (!/^[a-z]{2}(-[a-z]+)+-[1-9]$/.test(config.region) || !/^\d{12}$/.test(config.accountId))
      throw new Error("OIDC publication requires an AWS region and account ID");
    if (config.issuerUrl !== `https://${config.bucketName}.s3.${config.region}.amazonaws.com`)
      throw new Error("OIDC issuer must exactly match the regional HTTPS bucket origin");
    if (config.apiServerUrl) {
      const url = new URL(config.apiServerUrl);
      if (url.protocol !== "https:" || url.origin !== config.apiServerUrl || url.username || url.password)
        throw new Error("OIDC API server must be an HTTPS origin without credentials");
    }
    for (const key of ["sourceSecretName", "sourceSecretNamespace"] as const)
      if (!config[key]) throw new Error(`OIDC publication requires ${key}`);
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1", kind: "XAwsKubernetesOidcPublication",
      metadata: { name: config.name },
      spec: {
        crossplane: { compositionRef: { name: "aws-kubernetes-oidc-publication" } },
        ...config,
        sourceSecretKey: config.sourceSecretKey ?? "value",
        tlsSecretNamespace: config.tlsSecretNamespace ?? "crossplane-system",
        kubeProviderConfigName: config.kubeProviderConfigName ?? "kubernetes-provider-config",
        httpProviderConfigName: config.httpProviderConfigName ?? "default",
        awsProviderConfigName: config.awsProviderConfigName ?? "default",
        createBucket: config.createBucket ?? false,
        tags: config.tags ?? {},
      },
    });
  }
}

/** Install once with provider-kubernetes, provider-http >=1.0.14, provider-aws-s3,
 * function-go-templating >=0.9.0 and function-auto-ready. The HTTP provider needs
 * Secret read permission in tlsSecretNamespace. No cloud credentials enter the XR. */
export class AwsKubernetesOidcPublicationSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const string = { type: "string", minLength: 1 };
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: { name: "xawskubernetesoidcpublications.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: {
        group: "nebula.io", names: { kind: "XAwsKubernetesOidcPublication", plural: "xawskubernetesoidcpublications" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: {
          type: "object", properties: {
            spec: {
              type: "object",
              required: ["name", "issuerUrl", "bucketName", "region", "accountId", "sourceSecretName", "sourceSecretNamespace",
                "sourceSecretKey", "tlsSecretNamespace", "kubeProviderConfigName", "httpProviderConfigName", "awsProviderConfigName", "createBucket"],
              properties: {
                name: { ...string, pattern: "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$" },
                issuerUrl: string, bucketName: { ...string, pattern: "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$" },
                region: { ...string, pattern: "^[a-z]{2}(-[a-z]+)+-[1-9]$" }, accountId: { ...string, pattern: "^[0-9]{12}$" },
                sourceSecretName: string, sourceSecretNamespace: string, sourceSecretKey: string,
                apiServerUrl: string, tlsSecretNamespace: string,
                kubeProviderConfigName: string, httpProviderConfigName: string, awsProviderConfigName: string,
                createBucket: { type: "boolean" }, tags: { type: "object", additionalProperties: { type: "string" } },
              },
              "x-kubernetes-validations": [
                { rule: "self.issuerUrl == 'https://' + self.bucketName + '.s3.' + self.region + '.amazonaws.com'", message: "issuer must match the regional HTTPS bucket origin" },
                ...["issuerUrl", "bucketName", "region", "accountId", "name"].map(field => ({
                  rule: `self.${field} == oldSelf.${field}`, message: `${field} is immutable; migrate issuer identities explicitly`,
                })),
              ],
            },
            status: { type: "object", properties: { publicationReady: { type: "boolean" } } },
          },
        } } }],
      },
    });
    this.composition = new Composition(this, "composition", {
      metadata: { name: "aws-kubernetes-oidc-publication", annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: {
        compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XAwsKubernetesOidcPublication" },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "observe-validate-publish", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline",
          inline: { template: KUBERNETES_OIDC_PUBLICATION_TEMPLATE },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}
