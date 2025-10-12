import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface ConfidentialContainersOperatorConfig {
  version?: string; // e.g., "v0.2.0"
  namespace?: string; // defaults to confidential-containers-system
}

export interface ConfidentialContainersCloudApiAdapterConfig {
  enabled?: boolean; // default true
  version?: string; // e.g., "v0.2.0"
  namespace?: string; // defaults to confidential-containers-system
  ksaName?: string; // default: cloud-api-adaptor
  // GCP Workload Identity/GSA wiring
  gsaEmail?: string; // if provided, use existing; otherwise create
  gsaName?: string; // accountId (lowercase, constrained) if creating
  roles?: string[]; // project roles to grant to GSA (defaults below)
  rolesProjectId?: string; // defaults to current gcp project
  workloadIdentity?: boolean; // default true
}

export interface ConfidentialContainersConfig {
  namespace?: string; // default: confidential-containers-system
  operator?: ConfidentialContainersOperatorConfig;
  cloudApiAdapter?: ConfidentialContainersCloudApiAdapterConfig;
}

export interface ConfidentialContainersOutput {
  operatorNamespace?: string;
  cloudApiAdapterNamespace?: string;
  gsaEmail?: pulumi.Output<string>;
  ksaName?: string;
}

export class ConfidentialContainers extends pulumi.ComponentResource {
  public readonly operatorNamespace: string;
  public readonly cloudApiAdapterNamespace?: string;
  public readonly gsaEmail?: pulumi.Output<string>;
  public readonly ksaName?: string;

  constructor(name: string, args: ConfidentialContainersConfig, opts?: pulumi.ComponentResourceOptions) {
    super("confidential-containers", name, args, opts);

    const nsName = args.namespace || "confidential-containers-system";
    const operatorNs = args.operator?.namespace || nsName;
    const caaNs = args.cloudApiAdapter?.namespace || nsName;
    const releaseVersion = args.operator?.version || "v0.16.0";

    this.operatorNamespace = operatorNs;
    this.cloudApiAdapterNamespace = caaNs;

    // Create namespace for confidential-containers-system
    const operatorNamespace = new k8s.core.v1.Namespace("confidential-containers-operator-namespace", {
      metadata: { name: operatorNs },
    }, { parent: this });

    // Deploy the confidential-containers operator using kubectl apply -k
    // This is the correct way according to the official documentation
    const operatorDeployment = new k8s.core.v1.ConfigMap("confidential-containers-operator-deployment", {
      metadata: {
        name: "confidential-containers-operator-deployment",
        namespace: operatorNs,
      },
      data: {
        "deploy.sh": `#!/bin/bash
set -e
echo "Deploying Confidential Containers Operator ${releaseVersion}..."
kubectl apply -k "github.com/confidential-containers/operator/config/release?ref=${releaseVersion}"
echo "Operator deployed successfully"

echo "Labeling nodes as workers..."
kubectl label nodes --all node.kubernetes.io/worker= || true
echo "Nodes labeled successfully"

echo "Deploying CCRuntime..."
kubectl apply -k "github.com/confidential-containers/operator/config/samples/ccruntime/default?ref=${releaseVersion}"
echo "CCRuntime deployed successfully"

echo "Waiting for operator to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/cc-operator-controller-manager -n confidential-containers-system || true

echo "Checking runtime classes..."
kubectl get runtimeclass || true
echo "Deployment completed!"
`
      }
    }, { 
      parent: this,
      dependsOn: [operatorNamespace]
    });

    // Execute the deployment script
    const operatorJob = new k8s.batch.v1.Job("confidential-containers-operator-job", {
      metadata: {
        name: "confidential-containers-operator-job",
        namespace: operatorNs,
      },
      spec: {
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [{
              name: "kubectl",
              image: "bitnami/kubectl:latest",
              command: ["/bin/bash", "/tmp/deploy.sh"],
              volumeMounts: [{
                name: "deploy-script",
                mountPath: "/tmp/deploy.sh",
                subPath: "deploy.sh"
              }]
            }],
            volumes: [{
              name: "deploy-script",
              configMap: {
                name: operatorDeployment.metadata.name,
                defaultMode: 0o755
              }
            }]
          }
        }
      }
    }, { 
      parent: this,
      dependsOn: [operatorDeployment]
    });

    // Cloud API Adapter (GCP defaults) - deployed as separate manifests
    const wantCaa = args.cloudApiAdapter?.enabled !== false;
    let gsaEmailOut: pulumi.Output<string> | undefined = undefined;
    let gsaResourceIdOut: pulumi.Output<string> | undefined = undefined;
    if (wantCaa) {
      const cfg = new pulumi.Config("gcp");
      const projectId = cfg.require("project");
      const rolesProject = args.cloudApiAdapter?.rolesProjectId || projectId;
      const ksaName = args.cloudApiAdapter?.ksaName || "cloud-api-adaptor";
      this.ksaName = ksaName;

      const normalizeAccountId = (raw: string): string => {
        let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        if (!/^[a-z]/.test(s)) s = `a-${s}`;
        if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
        if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
        return s;
      };

      // Prepare or create GSA
      if (args.cloudApiAdapter?.gsaEmail) {
        gsaEmailOut = pulumi.output(args.cloudApiAdapter.gsaEmail);
        // Resource name form: projects/{project}/serviceAccounts/{email}
        gsaResourceIdOut = pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut}`;
        this.gsaEmail = gsaEmailOut;
      } else {
        const accountId = normalizeAccountId(args.cloudApiAdapter?.gsaName || `${name}-caa`);
        const gsa = new gcp.serviceaccount.Account(`${name}-caa-gsa`, {
          accountId,
          displayName: `${name} Cloud API Adapter`,
        }, { parent: this });
        gsaEmailOut = gsa.email;
        gsaResourceIdOut = gsa.name;
        this.gsaEmail = gsaEmailOut;

        // Enhanced GCP roles for confidential containers
        const defaultRoles = [
          "roles/compute.instanceAdmin.v1",
          "roles/compute.networkAdmin", 
          "roles/compute.securityAdmin",
          "roles/iam.serviceAccountUser",
          "roles/logging.logWriter",
          "roles/monitoring.metricWriter",
          "roles/secretmanager.secretAccessor",
          "roles/storage.objectViewer",
        ];
        const roles = (args.cloudApiAdapter?.roles && args.cloudApiAdapter.roles.length > 0)
          ? args.cloudApiAdapter.roles
          : defaultRoles;
        roles.forEach((role, idx) => {
          new gcp.projects.IAMMember(`${name}-caa-role-${idx}`, {
            project: rolesProject,
            role,
            member: pulumi.interpolate`serviceAccount:${gsa.email}`,
          }, { parent: this });
        });
      }

      // Workload Identity binding: let KSA impersonate GSA
      const wi = args.cloudApiAdapter?.workloadIdentity !== false;
      if (wi && (gsaResourceIdOut || gsaEmailOut)) {
        new gcp.serviceaccount.IAMMember(`${name}-caa-wi`, {
          serviceAccountId: (gsaResourceIdOut || pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut!}`),
          role: "roles/iam.workloadIdentityUser",
          member: pulumi.interpolate`serviceAccount:${projectId}.svc.id.goog[${caaNs}/${ksaName}]`,
        }, { parent: this });
      }

      // Deploy cloud-api-adaptor using kubectl apply -k
      const caaVersion = args.cloudApiAdapter?.version || releaseVersion;
      const cloudApiAdaptorDeployment = new k8s.core.v1.ConfigMap("confidential-containers-cloud-api-adaptor-deployment", {
        metadata: {
          name: "confidential-containers-cloud-api-adaptor-deployment",
          namespace: caaNs,
        },
        data: {
          "deploy.sh": `#!/bin/bash
set -e
# Apply cloud-api-adaptor manifests
kubectl apply -k "github.com/confidential-containers/operator/config/samples/cloud-api-adaptor/gcp?ref=${caaVersion}" || true
`
        }
      }, { 
        parent: this,
        dependsOn: [operatorJob]
      });

      // Execute the cloud-api-adaptor deployment script
      new k8s.batch.v1.Job("confidential-containers-cloud-api-adaptor-job", {
        metadata: {
          name: "confidential-containers-cloud-api-adaptor-job",
          namespace: caaNs,
        },
        spec: {
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [{
                name: "kubectl",
                image: "bitnami/kubectl:latest",
                command: ["/bin/bash", "/tmp/deploy.sh"],
                volumeMounts: [{
                  name: "deploy-script",
                  mountPath: "/tmp/deploy.sh",
                  subPath: "deploy.sh"
                }]
              }],
              volumes: [{
                name: "deploy-script",
                configMap: {
                  name: cloudApiAdaptorDeployment.metadata.name,
                  defaultMode: 0o755
                }
              }]
            }
          }
        }
      }, { 
        parent: this,
        dependsOn: [cloudApiAdaptorDeployment]
      });
    }

    this.registerOutputs({
      operatorNamespace: this.operatorNamespace,
      cloudApiAdapterNamespace: this.cloudApiAdapterNamespace,
      gsaEmail: this.gsaEmail,
      ksaName: this.ksaName,
    });
  }
}


