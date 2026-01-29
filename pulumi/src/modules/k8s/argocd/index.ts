/**
 * ArgoCd - GitOps continuous delivery tool for Kubernetes.
 * 
 * @example
 * ```typescript
 * import { ArgoCd } from 'nebula/k8s/argocd';
 * 
 * const argocd = new ArgoCd('argocd', {
 *   values: {
 *     server: {
 *       ingress: { enabled: true, hostname: 'argocd.example.com' }
 *     }
 *   }
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import bcrypt from "bcryptjs";
import * as yaml from 'yaml';
import { deepmerge } from "deepmerge-ts";
import type { ArgoCdConfig, OptionalChartArgs } from "./types";
import { BaseModule } from "../../../core/base-module";
import { Helpers } from "../../../utils/helpers";

export * from "./types";

function flattenKeys(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, flattenKeys(value, newKey));
      } else {
        result[newKey] = value;
      }
    }
  }
  return result;
}

export class ArgoCd extends BaseModule {
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: ArgoCdConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:ArgoCd', name, args as unknown as Record<string, unknown>, opts);

    const namespaceName = args.namespace || 'argocd';

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    // Precreate Redis password secret; ignore future content changes so it remains stable
    const generatedRedisPassword = pulumi.secret(crypto.randomBytes(24).toString('base64'));
    const redisSecret = new k8s.core.v1.Secret(`${name}-redis-secret`, {
      metadata: { name: 'argocd-redis', namespace: namespaceName },
      stringData: {
        'auth': generatedRedisPassword,
        'redis-password': generatedRedisPassword,
      },
    }, { parent: this, dependsOn: [this.namespace], ignoreChanges: ["data", "stringData"] });

    // Handle Crossplane User - need to process this early for the argocd-secret
    let crossplanePassword: pulumi.Input<string> | undefined;
    let crossplanePasswordHash: string | undefined;
    
    if (args.crossplaneUser?.enabled && args.crossplaneUser.password) {
      // Resolve password if it's a ref+ string
      const rawPassword = args.crossplaneUser.password;
      const resolvedPassword = typeof rawPassword === 'string' && rawPassword.startsWith('ref+')
        ? Helpers.resolveRefPlusSecretsDeep(rawPassword, false, 'crossplanePassword')
        : rawPassword;
      
      crossplanePassword = resolvedPassword;
      const salt = bcrypt.genSaltSync(10);
      crossplanePasswordHash = bcrypt.hashSync(resolvedPassword as string, salt);
    }

    // Precreate ArgoCD server secret; ignore future changes so JWT tokens remain valid
    const generatedServerSecretKey = pulumi.secret(crypto.randomBytes(32).toString('base64'));
    const argocdSecretData: Record<string, pulumi.Input<string>> = {
      'server.secretkey': generatedServerSecretKey,
    };
    
    // Add crossplane user password to the pre-created secret if enabled
    if (crossplanePasswordHash) {
      argocdSecretData['accounts.crossplane.password'] = crossplanePasswordHash;
      argocdSecretData['accounts.crossplane.enabled'] = 'true';
    }
    
    const argocdServerSecret = new k8s.core.v1.Secret(`${name}-server-secret`, {
      metadata: { 
        name: 'argocd-secret', 
        namespace: namespaceName,
        labels: {
          'app.kubernetes.io/name': 'argocd-secret',
          'app.kubernetes.io/part-of': 'argocd',
        },
      },
      stringData: argocdSecretData,
    }, { parent: this, dependsOn: [this.namespace], ignoreChanges: ["data", "stringData"] });

    const defaultValues: Record<string, unknown> = {
      crds: { install: true },
      configs: {
        secret: {
          createSecret: false, // We pre-create argocd-secret to keep server.secretkey stable
        },
      },
      repoServer: {},
      controller: {},
      server: {},
      applicationSet: {},
      redis: { 
        // The Argo CD chart's internal Redis uses secret 'argocd-redis' with key 'auth'.
        auth: { existingSecret: 'argocd-redis', existingSecretPasswordKey: 'redis-password' },
      },
      dex: {},
      notifications: {},
    };

    // Merge default values with user-provided values, then resolve any ref+ secrets
    const mergedValues: Record<string, any> = deepmerge(defaultValues, args.values || {});
    const chartValues: Record<string, any> = Helpers.resolveRefPlusSecretsDeep(mergedValues, false, 'chartValues');

    // Flatten configs.params and configs.cm for nested objects
    if (chartValues["configs"]) {
      if (chartValues["configs"]["params"]) {
        chartValues["configs"]["params"] = flattenKeys(chartValues["configs"]["params"]);
      }
      if (chartValues["configs"]["cm"]) {
         // Note: configs.cm normally takes simple key-value pairs where values are strings. 
         // If we added nested objects there (like application: { instanceLabelKey: "..." }), 
         // we might need flattening or special handling. 
         // Based on types.ts update, we have application? and oidc?.
         if (chartValues["configs"]["cm"]["dex"] && chartValues["configs"]["cm"]["dex"]["config"] && typeof chartValues["configs"]["cm"]["dex"]["config"] !== 'string') {
           chartValues["configs"]["cm"]["dex"]["config"] = yaml.stringify(chartValues["configs"]["cm"]["dex"]["config"]);
         }
         chartValues["configs"]["cm"] = flattenKeys(chartValues["configs"]["cm"]);
      }
      if (chartValues["configs"]["clusterCredentials"]) {
       
        const credsMap = chartValues["configs"]["clusterCredentials"];
        if (credsMap && !Array.isArray(credsMap)) {
           chartValues["configs"]["clusterCredentials"] = Object.values(credsMap);
        }
      }
    }

    // Add crossplane user to argocd-cm if enabled
    if (args.crossplaneUser?.enabled) {
      if (!chartValues["configs"]) chartValues["configs"] = {};
      if (!chartValues["configs"]["cm"]) chartValues["configs"]["cm"] = {};
      chartValues["configs"]["cm"]["accounts.crossplane"] = "apiKey, login";
    }

    const safeChartValues = chartValues;

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'argo-cd',
      repositoryOpts: { repo: args.repository || 'https://argoproj.github.io/argo-helm' },
      version: args.version || '9.3.5',
      namespace: namespaceName,
    };
    const providedArgs: OptionalChartArgs | undefined = args.args;

    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values: safeChartValues,
    };


    this.chart = new k8s.helm.v4.Chart(name, finalChartArgs, {
      parent: this,
      dependsOn: [this.namespace, redisSecret, argocdServerSecret],
    });

    // Handle Crossplane User Bootstrapping
    if (args.crossplaneUser?.enabled) {
      const user = "crossplane";
      const jobName = `argocd-token-bootstrap-${user}`;
      const secretName = "argocd-crossplane-creds";
      const targetNamespace = "crossplane-system"; // Hardcoded for standard Nebula convention

      // Create the crossplane-system namespace (needed for Role/RoleBinding before Crossplane is deployed)
      const crossplaneNamespace = new k8s.core.v1.Namespace(`${name}-crossplane-namespace`, {
        metadata: { name: targetNamespace },
      }, { parent: this });

      // Create a secret to hold the password for the job
      const bootstrapSecretName = `${jobName}-password`;
      const bootstrapSecret = new k8s.core.v1.Secret(bootstrapSecretName, {
        metadata: { name: bootstrapSecretName, namespace: namespaceName },
        stringData: {
          password: crossplanePassword!,
        },
      }, { parent: this, dependsOn: [this.namespace] });

      // Create ServiceAccount for the Job
      const sa = new k8s.core.v1.ServiceAccount(jobName, {
        metadata: { name: jobName, namespace: namespaceName },
      }, { parent: this, dependsOn: [this.namespace] });

      // So we need a Role in crossplane-system.
      const secretRole = new k8s.rbac.v1.Role(`${jobName}-secret`, {
        metadata: { name: jobName, namespace: targetNamespace },
        rules: [
          { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "patch", "update"] },
        ],
      }, { parent: this, dependsOn: [crossplaneNamespace] });

      new k8s.rbac.v1.RoleBinding(`${jobName}-secret`, {
        metadata: { name: jobName, namespace: targetNamespace },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: jobName },
        subjects: [{ kind: "ServiceAccount", name: jobName, namespace: namespaceName }], // Binding SA from argocd ns
      }, { parent: this, dependsOn: [sa, secretRole] });

      // The Job - recreate when argocd-secret changes (e.g., after manual deletion)
      new k8s.batch.v1.Job(jobName, {
        metadata: { 
          name: jobName, 
          namespace: namespaceName,
          annotations: {
            "pulumi.com/waitFor": "condition=complete", // Wait for completion
            // Track argocd-secret UID to trigger job recreation if secret is recreated
            "argocd-secret-uid": argocdServerSecret.metadata.uid,
          }
        },
        spec: {
          backoffLimit: 4,
          template: {
            spec: {
              serviceAccountName: jobName,
              restartPolicy: "OnFailure",
              containers: [{
                name: "argocd-cli",
                image: "debian:bookworm-slim",
                command: ["/bin/bash", "-c"],
                args: [`
                  set -e
                  
                  # Install dependencies
                  apt-get update && apt-get install -y curl ca-certificates
                  
                  # Install kubectl
                  curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
                  chmod +x kubectl
                  mv kubectl /usr/local/bin/
                  
                  # Install argocd cli
                  echo "Installing ArgoCD CLI..."
                  curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/download/v2.13.2/argocd-linux-amd64
                  chmod +x /usr/local/bin/argocd
                  
                  echo "Waiting for ArgoCD server..."
                  until echo "y" | argocd login argocd-server.${namespaceName}.svc.cluster.local --username ${user} --password "$USER_PASSWORD" --insecure --grpc-web --plaintext; do
                    echo "Login failed, retrying in 5s..."
                    sleep 5
                  done
                  echo "Logged in successfully."

                  echo "Generating token..."
                  TOKEN=$(argocd account generate-token --account ${user})

                  echo "Creating Secret ${secretName} in ${targetNamespace}..."
                  kubectl create secret generic ${secretName} \
                    --namespace ${targetNamespace} \
                    --from-literal=authToken=$TOKEN \
                    --dry-run=client -o yaml | kubectl apply -f -
                `],
                env: [
                  { 
                    name: "USER_PASSWORD", 
                    valueFrom: {
                      secretKeyRef: {
                        name: bootstrapSecret.metadata.name,
                        key: "password",
                      },
                    },
                  },
                ],
              }],
            },
          },
        },
      }, { 
        parent: this, 
        dependsOn: [this.chart, argocdServerSecret],
        deleteBeforeReplace: true,  // Delete old job before creating new one
        replaceOnChanges: ["metadata.annotations"],  // Replace job when annotations change
      });
    }

    // Optional: Create an AppProject
    if (args.project?.name) {
      new k8s.apiextensions.CustomResource(`${name}-project`, {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'AppProject',
        metadata: { name: args.project.name, namespace: namespaceName },
        spec: {
          description: args.project.description || '',
          sourceRepos: args.project.sourceRepos || ['*'],
          destinations: (args.project.destinations || [{ server: 'https://kubernetes.default.svc', namespace: '*' }])
            .map(d => ({ server: d.server || 'https://kubernetes.default.svc', namespace: d.namespace || '*', name: d.name })),
          ...(args.project.clusterResourceWhitelist ? { clusterResourceWhitelist: args.project.clusterResourceWhitelist } : {}),
          ...(args.project.namespaceResourceWhitelist ? { namespaceResourceWhitelist: args.project.namespaceResourceWhitelist } : {}),
        },
      }, { parent: this, dependsOn: [this.chart] });
    }

    this.registerOutputs({});
  }
}
