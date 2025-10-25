import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
// No Kubernetes objects created here; this module only manages GCP WI resources

export interface WorkloadIdentityConfig {
  /** Pool identifier (short ID). Default: "k8s" */
  poolId?: string;
  poolDisplayName?: string;
  /** Provider identifier within the pool. Default: "k8s" */
  providerId?: string;
  providerDisplayName?: string;
  /** OIDC issuer URI of the cluster's service account tokens. */
  issuerUri?: string; // If not provided, and exposeIssuer+issuerHost are set, we'll derive https://<issuerHost>
  /** Allowed audiences for STS. If unset, defaults to none (audience not enforced). */
  allowedAudiences?: string[];
  /** Attribute mapping for the provider. Default: { "google.subject": "assertion.sub" } */
  attributeMapping?: Record<string, string>;
  /** Project that hosts the GSAs and where roles will be granted. Defaults to current gcp:project. */
  projectId?: string;
  /** When true, create an Ingress that exposes the API server's OIDC discovery and JWKS endpoints. */
  exposeIssuer?: boolean;
  /** Public hostname for the exposed issuer, e.g. oidc.example.com. Required when exposeIssuer is true. */
  issuerHost?: string;
  /** Ingress class name (e.g., nginx). Optional. */
  issuerIngressClassName?: string;
  /** Namespace for the Ingress resource. Default: "default". */
  issuerNamespace?: string;
  /** Root DNS name (e.g., example.com) used to look up the Cloud DNS managed zone for issuerHost. */
  issuerRootDomain?: string;
}

export interface WorkloadIdentityOutputs {
  poolName: pulumi.Output<string>;
  providerName: pulumi.Output<string>;
  providerFullName: pulumi.Output<string>;
  audience: pulumi.Output<string>;
}

export class WorkloadIdentity extends pulumi.ComponentResource {
  public readonly outputs: WorkloadIdentityOutputs;

  constructor(name: string, args: WorkloadIdentityConfig, opts?: pulumi.ComponentResourceOptions) {
    super("workload-identity", name, args, opts);

    const cfg = new pulumi.Config("gcp");
    const projectId = args.projectId || cfg.require("project");
    const project = gcp.organizations.getProjectOutput({ projectId });
    const projectNumber = project.number;

    const poolId = args.poolId || "k8s";
    const providerId = args.providerId || "k8s";

    const pool = new gcp.iam.WorkloadIdentityPool(`${name}-pool`, {
      project: projectId,
      workloadIdentityPoolId: poolId,
      displayName: args.poolDisplayName || `${name} pool`,
    }, { parent: this });

    const attributeMapping = args.attributeMapping && Object.keys(args.attributeMapping).length > 0
      ? args.attributeMapping
      : { "google.subject": "assertion.sub" };

    // Derive issuerUri if not provided but a public issuer host is specified for exposure
    const derivedIssuerUri = (!args.issuerUri && args.exposeIssuer && args.issuerHost)
      ? `https://${args.issuerHost}`
      : args.issuerUri;
    if (!derivedIssuerUri) {
      throw new Error("workload-identity: issuerUri is required unless exposeIssuer=true with issuerHost set");
    }

    const provider = new gcp.iam.WorkloadIdentityPoolProvider(`${name}-provider`, {
      project: projectId,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: providerId,
      displayName: args.providerDisplayName || `${name} provider`,
      attributeMapping,
      oidc: args.allowedAudiences && args.allowedAudiences.length > 0 ? {
        issuerUri: derivedIssuerUri,
        allowedAudiences: args.allowedAudiences,
      } : { issuerUri: derivedIssuerUri },
    }, { parent: this, dependsOn: [pool] });

    const providerFullName = pulumi.interpolate`projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
    const audience = pulumi.interpolate`//iam.googleapis.com/${providerFullName}`;

    // Optionally expose the issuer endpoints publicly using an Ingress
    if (args.exposeIssuer && args.issuerHost) {
      const ns = args.issuerNamespace || "default";
      const tlsSecretName = `${args.issuerHost}-tls`;
      const ingressAnnotations: Record<string, string> = {
        // Ensure we speak HTTPS to the Kubernetes API service
        "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
        // The API server cert will not match the public hostname; disable backend cert verification
        "nginx.ingress.kubernetes.io/proxy-ssl-verify": "off",
        "nginx.ingress.kubernetes.io/ssl-redirect": "true",
        // Help older controllers and some setups select the class
        "kubernetes.io/ingress.class": args.issuerIngressClassName || "nginx",
        // Trigger cert-manager IngressShim for TLS issuance
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
      };

      const issuerIngress = new k8s.networking.v1.Ingress(`${name}-issuer-ingress`, {
        metadata: {
          name: `${name}-issuer`,
          namespace: ns,
          annotations: ingressAnnotations,
        },
        spec: {
          ingressClassName: args.issuerIngressClassName || "nginx",
          tls: [{ hosts: [args.issuerHost], secretName: tlsSecretName }],
          rules: [
            {
              host: args.issuerHost,
              http: {
                paths: [
                  {
                    path: "/.well-known/openid-configuration",
                    pathType: "Prefix",
                    backend: { service: { name: "kubernetes", port: { number: 6443 } } },
                  },
                  {
                    path: "/openid/v1/jwks",
                    pathType: "Prefix",
                    backend: { service: { name: "kubernetes", port: { number: 6443 } } },
                  },
                ],
              },
            },
          ],
        },
      }, { parent: this });

      // Create a Certificate via cert-manager for issuerHost
      new k8s.apiextensions.CustomResource(`${name}-issuer-cert`, {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: `${name}-issuer-cert`, namespace: ns },
        spec: {
          secretName: tlsSecretName,
          dnsNames: [args.issuerHost],
          issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
        },
      }, { parent: this, dependsOn: [issuerIngress] });

      // If a root domain is provided, create a Cloud DNS record pointing the issuerHost to the Ingress LB
      if (args.issuerRootDomain) {
        const zones = gcp.dns.getManagedZonesOutput({ project: projectId });
        const zoneName = zones.managedZones.apply(zs => {
          const wantDns = args.issuerRootDomain!.endsWith('.') ? args.issuerRootDomain! : `${args.issuerRootDomain!}.`;
          const byExact = zs.find(z => z.dnsName === wantDns);
          const bySuffix = byExact || zs.find(z => wantDns.endsWith(z.dnsName));
          return bySuffix?.name || args.issuerRootDomain!; // fallback to provided string
        });

        // Extract the first LB entry (ip or hostname) from the ingress status
        const lbEntry = issuerIngress.status.apply(st => {
          const list: any[] = (st as any)?.loadBalancer?.ingress || [];
          return list[0] || {};
        });
        const recordType = lbEntry.apply((e: any) => e.ip ? "A" : "CNAME");
        const rrdata = lbEntry.apply((e: any) => {
          if (e.ip) return [String(e.ip)];
          const host = String(e.hostname || "");
          return [host.endsWith('.') ? host : `${host}.`];
        });

        new gcp.dns.RecordSet(`${name}-issuer-dns`, {
          managedZone: zoneName,
          name: pulumi.interpolate`${args.issuerHost}.`,
          type: recordType,
          ttl: 300,
          rrdatas: rrdata,
        }, { parent: this, dependsOn: [issuerIngress] });
      }
    }

    this.outputs = {
      poolName: pool.name,
      providerName: provider.name,
      providerFullName,
      audience,
    };
    this.registerOutputs(this.outputs);
  }
}


