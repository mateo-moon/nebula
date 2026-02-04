/**
 * Workloads - Deploy to GKE cluster
 * 
 * Deploys Kubernetes workloads to the GKE cluster:
 * - Cert-Manager for TLS certificates
 * - Ingress-NGINX for ingress controller
 * - External-DNS for DNS record management
 * - Prometheus Operator for monitoring
 * - ArgoCD for GitOps
 * - Cluster API Operator for cluster management
 * 
 * Prerequisites:
 *   - GKE cluster created by infra.ts
 *   - kubectl context switched to GKE cluster
 *   - gcloud container clusters get-credentials dev-gke --zone europe-west3-a
 * 
 * Usage:
 *   nebula synth --app example/workloads.ts
 *   nebula apply
 */
import { App, Chart } from 'cdk8s';
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
const chart = new Chart(app, 'workloads');

const domain = 'dev.example.com';
const project = 'my-gcp-project';

// Shared config for inter-module dependencies
const crossplaneNamespace = 'crossplane-system';
const argoCdNamespace = 'argocd';
const argoCdCredentialsSecretName = 'argocd-crossplane-creds';
const argoCdCredentialsSecretKey = 'authToken';

// Crossplane on GKE (for managing additional resources via ArgoCD)
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
  acmeEmail: 'admin@example.com',
});

// ClusterApiOperator - Cluster lifecycle management
new ClusterApiOperator(chart, 'capi', {});

// IngressNginx - Ingress controller
new IngressNginx(chart, 'ingress-nginx', {
  useCertManager: true,
  controller: {
    replicaCount: 2,
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
  project: project,
  domainFilters: [domain],
  policy: 'sync',
  txtOwnerId: 'example-dev',
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
new ArgoCd(chart, 'argocd', {
  namespace: argoCdNamespace,
  crossplaneUser: {
    enabled: true,
    password: 'crossplane-password', // In production, use secrets manager
    targetNamespace: crossplane.namespaceName,
    credentialsSecretName: crossplane.credentialsSecretName,
    credentialsSecretKey: crossplane.credentialsSecretKey,
    skipNamespaceCreation: true,
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
    extraObjects: [
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'argocd-oidc',
          namespace: argoCdNamespace,
          labels: { 'app.kubernetes.io/part-of': 'argocd' },
        },
        type: 'Opaque',
        stringData: {
          clientID: 'your-github-client-id',
          clientSecret: 'your-github-client-secret',
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'repo-my-org-devops',
          namespace: argoCdNamespace,
          labels: { 'argocd.argoproj.io/secret-type': 'repository' },
        },
        type: 'Opaque',
        stringData: {
          type: 'git',
          url: 'git@github.com:my-org/devops.git',
          sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----',
        },
      },
    ],
    repoServer: {
      env: [{ name: 'ARGOCD_EXEC_TIMEOUT', value: '5m' }],
      nodeSelector: { 'workload': 'argocd' },
      tolerations: [{ key: 'workload', value: 'argocd', effect: 'NoSchedule' }],
    },
    configs: {
      params: {
        server: { insecure: true },
      },
      rbac: {
        'policy.csv': `p, role:developer, applications, *, development/*, allow
p, role:developer, logs, *, development/*, allow
p, role:developer, exec, *, development/*, allow
g, MyOrg:DevOps, role:admin
g, MyOrg:Engineers, role:developer
g, crossplane, role:admin`,
      },
      cm: {
        url: `https://argocd.${domain}`,
        admin: { enabled: 'false' },
        dex: {
          config: {
            connectors: [{
              type: 'github',
              id: 'github',
              name: 'GitHub',
              config: {
                clientID: '$clientID',
                clientSecret: '$clientSecret',
                orgs: [{ name: 'MyOrg' }],
              },
            }],
          },
        },
        exec: { enabled: 'true' },
        server: {
          rbac: { log: { enforce: { enable: 'true' } } },
        },
      },
    },
    dex: {
      envFrom: [{ secretRef: { name: 'argocd-oidc' } }],
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
          secretName: 'argocd-tls',
          hosts: [`argocd.${domain}`],
        }],
      },
    },
  },
});

app.synth();
