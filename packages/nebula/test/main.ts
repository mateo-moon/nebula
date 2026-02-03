import { App, Chart } from 'cdk8s';
import { Gcp, NetworkSpecDeletionPolicy } from '../src/modules/infra/gcp';
import { Dns, ManagedZoneSpecDeletionPolicy } from '../src/modules/infra/dns';
import { GcpProvider } from '../src/modules/providers';
import {
  Crossplane,
  CertManager,
  ClusterApiOperator,
  IngressNginx,
  ExternalDns,
  PrometheusOperator,
  ArgoCd,
} from '../src/modules/k8s';

const app = new App();
const chart = new Chart(app, 'nebula-infra-test');

// Create GCP Provider and ProviderConfig (including dns family)
new GcpProvider(chart, 'gcp-provider', {
  projectId: 'geometric-watch-472309-h6',
  families: ['compute', 'container', 'cloudplatform', 'dns'],
  credentials: {
    type: 'secret',
    secretRef: {
      name: 'gcp-creds',
      namespace: 'crossplane-system',
      key: 'creds',
    },
  },
});

new Gcp(chart, 'nebula', {
  project: 'geometric-watch-472309-h6',
  region: 'europe-west3',
  providerConfigRef: 'default',
  deletionPolicy: NetworkSpecDeletionPolicy.DELETE,

  network: {
    cidr: '10.10.0.0/16',
    podsSecondaryCidr: '10.20.0.0/16',
    podsRangeName: 'pods',
    servicesSecondaryCidr: '10.30.0.0/16',
    servicesRangeName: 'services',
  },

  gke: {
    name: 'dev-gke',
    location: 'europe-west3-a',
    releaseChannel: 'REGULAR',
    deletionProtection: false,
    createSystemNodePool: true,
    systemNodePoolConfig: {
      imageType: 'UBUNTU_CONTAINERD',
      machineType: 'n2d-standard-2',  // 2 vCPU, 8GB RAM
      diskSizeGb: 50,
      minNodes: 2,
      maxNodes: 2,
      spot: true,
    },
    nodePools: {
      argocd: {
        imageType: 'UBUNTU_CONTAINERD',
        machineType: 'e2-standard-8',  // 8 vCPU, 32GB RAM - best value for bursty workloads
        diskSizeGb: 100,
        minNodes: 1,
        maxNodes: 1,
        spot: true,
        labels: {
          'workload': 'argocd',
        },
        taints: [
          {
            key: 'workload',
            value: 'argocd',
            effect: 'NO_SCHEDULE',
          },
        ],
      },
    },
  },

  iam: {
    externalDns: {
      enabled: true,
      namespace: 'external-dns',
      ksaName: 'external-dns',
      roles: ['roles/dns.admin'],
    },
    certManager: {
      enabled: true,
      namespace: 'cert-manager',
      ksaName: 'cert-manager',
      roles: ['roles/dns.admin'],
    },
  },
});

// Create DNS zone with manual delegation
// NS records need to be created manually in Cloudflare (zone: 2863158632d3ac4026316b87c1482a2c)
// Point 'dev.kampe.la' to GCP nameservers:
//   - ns-cloud-a1.googledomains.com
//   - ns-cloud-a2.googledomains.com
//   - ns-cloud-a3.googledomains.com
//   - ns-cloud-a4.googledomains.com
new Dns(chart, 'dns', {
  project: 'geometric-watch-472309-h6',
  providerConfigRef: 'default',
  deletionPolicy: ManagedZoneSpecDeletionPolicy.DELETE,
  zones: [
    {
      name: 'dev',
      dnsName: 'dev.kampe.la',
      description: 'Dev zone for nebula',
      // Using manual delegation - create NS records in Cloudflare manually
      delegation: {
        provider: 'manual',
      },
    },
  ],
  records: [
    {
      zoneName: 'dev',
      name: 'test',
      type: 'A',
      ttl: 300,
      rrdatas: ['1.2.3.4'],
    },
  ],
});

// ============================================================================
// Kubernetes Modules
// ============================================================================

const domain = 'dev.kampe.la';

// Define shared config for inter-module dependencies
const crossplaneNamespace = 'crossplane-system';
const argoCdNamespace = 'argocd';
const argoCdCredentialsSecretName = 'argocd-crossplane-creds';
const argoCdCredentialsSecretKey = 'authToken';

// Crossplane - Universal control plane
// Note: ArgoCD provider needs to know ArgoCD's namespace for serverAddr
const crossplane = new Crossplane(chart, 'crossplane', {
  namespace: crossplaneNamespace,
  argoCdProvider: {
    argoCdNamespace: argoCdNamespace,
    credentialsSecretName: argoCdCredentialsSecretName,
    credentialsSecretKey: argoCdCredentialsSecretKey,
  },
});

// CertManager - TLS certificate management
new CertManager(chart, 'cert-manager', {
  acmeEmail: 'devops@kampe.la',
});

// ClusterApiOperator - Cluster lifecycle management
new ClusterApiOperator(chart, 'capi', {});

// IngressNginx - Ingress controller
new IngressNginx(chart, 'ingress-nginx', {
  useCertManager: true,
  controller: {
    replicaCount: 1,
    service: {
      type: 'LoadBalancer',
    },
  },
  values: {
    controller: {
      admissionWebhooks: {
        certManager: {
          enabled: true,
        },
      },
    },
  },
});

// ExternalDns - DNS record management
new ExternalDns(chart, 'external-dns', {
  project: 'geometric-watch-472309-h6',
  domainFilters: ['dev.kampe.la'],
  policy: 'sync',
  txtOwnerId: 'kampe-la-dev',
  logLevel: 'debug',
  providerConfigRef: 'default',
});

// PrometheusOperator - Monitoring stack
new PrometheusOperator(chart, 'monitoring', {
  storageClassName: 'standard',
  grafanaAdminPassword: 'admin',
  loki: { enabled: true },
  promtail: { enabled: true },
});

// ArgoCd - GitOps continuous delivery
// Note: Uses Crossplane's namespace and secret name for credential bootstrapping
new ArgoCd(chart, 'argocd', {
  namespace: argoCdNamespace,
  // Crossplane user for ArgoCD provider integration
  // These values must match what Crossplane's ProviderConfig expects
  crossplaneUser: {
    enabled: true,
    password: 'crossplane-password', // In production, use secrets manager
    // Reference Crossplane's outputs to ensure consistency
    targetNamespace: crossplane.namespaceName,
    credentialsSecretName: crossplane.credentialsSecretName,
    credentialsSecretKey: crossplane.credentialsSecretKey,
    skipNamespaceCreation: true, // Crossplane creates the namespace
  },
  project: {
    name: 'default',
    description: 'Default project',
    sourceRepos: ['*'],
    destinations: [
      { server: 'https://kubernetes.default.svc', namespace: '*' },
    ],
  },
  values: {
    // Extra objects for OIDC and repository secrets
    extraObjects: [
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'argocd-oidc',
          namespace: 'argocd',
          labels: {
            'app.kubernetes.io/part-of': 'argocd',
          },
        },
        type: 'Opaque',
        stringData: {
          clientID: 'github-client-id', // In production, use secrets manager
          clientSecret: 'github-client-secret',
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'repo-kalapaja-devops',
          namespace: 'argocd',
          labels: {
            'argocd.argoproj.io/secret-type': 'repository',
          },
        },
        type: 'Opaque',
        stringData: {
          type: 'git',
          url: 'git@github.com:Kalapaja/devops.git',
          sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----',
        },
      },
    ],
    repoServer: {
      env: [
        { name: 'ARGOCD_EXEC_TIMEOUT', value: '5m' },
      ],
      // Schedule repo-server on dedicated argocd node
      nodeSelector: { 'workload': 'argocd' },
      tolerations: [{ key: 'workload', value: 'argocd', effect: 'NoSchedule' }],
    },
    configs: {
      params: {
        server: {
          insecure: true,
        },
      },
      rbac: {
        'policy.csv': `p, role:developer, applications, *, development/*, allow
p, role:developer, logs, *, development/*, allow
p, role:developer, exec, *, development/*, allow
g, Kalapaja:DevOps, role:admin
g, Kalapaja:Engineers, role:developer
g, crossplane, role:admin`,
      },
      cm: {
        url: `https://argocd.${domain}`,
        admin: {
          enabled: 'false',
        },
        // GitHub OIDC via Dex
        dex: {
          config: {
            connectors: [{
              type: 'github',
              id: 'github',
              name: 'GitHub',
              config: {
                clientID: '$clientID',
                clientSecret: '$clientSecret',
                orgs: [{
                  name: 'Kalapaja',
                }],
              },
            }],
          },
        },
        exec: {
          enabled: 'true',
        },
        server: {
          rbac: {
            log: {
              enforce: {
                enable: 'true',
              },
            },
          },
        },
      },
    },
    // Dex configuration - read secrets from argocd-oidc
    dex: {
      envFrom: [
        {
          secretRef: {
            name: 'argocd-oidc',
          },
        },
      ],
    },
    server: {
      ingress: {
        enabled: true,
        hostname: `argocd.${domain}`,
        annotations: {
          'cert-manager.io/cluster-issuer': 'letsencrypt-stage',
          'external-dns.alpha.kubernetes.io/hostname': `argocd.${domain}`,
        },
        ingressClassName: 'nginx',
        tls: [{
          secretName: 'argocd-dev-tls',
          hosts: [`argocd.${domain}`],
        }],
      },
    },
  },
});

app.synth();
