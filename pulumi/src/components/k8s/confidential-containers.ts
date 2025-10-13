import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface ConfidentialContainersOperatorConfig {
  version?: string; // default v0.16.0
  namespace?: string; // defaults to confidential-containers-system
}

export interface ConfidentialContainersCloudApiAdapterConfig {
  enabled?: boolean; // default true
  version?: string; // default same as operator
  namespace?: string; // defaults to confidential-containers-system
  ksaName?: string; // default: cloud-api-adaptor
  // GCP Workload Identity/GSA wiring
  gsaEmail?: string; // if provided, use existing; otherwise create
  gsaName?: string; // accountId (lowercase, constrained) if creating
  roles?: string[]; // project roles to grant to GSA (defaults below)
  rolesProjectId?: string; // defaults to current gcp project
  workloadIdentity?: boolean; // default true
  // PodVM/CAA runtime tuning for GCP (passed to kustomize via env)
  podVm?: {
    imageName?: string;              // value for PODVM_IMAGE_NAME
    instanceType?: string;           // e.g., c3-standard-4 (TDX)
    confidentialType?: string;       // TDX | SEV | SEV_SNP | ''
    diskType?: string;               // e.g., pd-balanced
    disableCvm?: boolean;            // default false
    extraEnv?: Record<string, string>;
  };
  // CAA container image override
  containerImage?: {
    repository?: string;             // e.g., ghcr.io/confidential-containers/cloud-api-adaptor
    tag?: string;                    // e.g., latest
    pullPolicy?: "Always" | "IfNotPresent" | "Never";
  };
  // GCP specifics
  gcpZone?: string;                  // sets GCP_ZONE in peer-pods-cm
  gcpCredentialsJson?: string;       // JSON for GCP_CREDENTIALS secret
  extraKustomize?: string[];         // additional kustomize URLs to apply
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

    // Namespace
    const operatorNamespace = new k8s.core.v1.Namespace("confidential-containers-namespace", {
      metadata: { name: operatorNs },
    }, { parent: this });

    // Operator (release) via kustomize Directory (use kustomize remote ref syntax: repo//path?ref=tag)
    const opRef = releaseVersion.startsWith('v') ? releaseVersion : `v${releaseVersion}`;
    const operatorRelease = new k8s.kustomize.v2.Directory("cc-operator-release", {
      directory: `https://github.com/confidential-containers/operator//config/release?ref=${opRef}`,
    }, { parent: this, dependsOn: [operatorNamespace] });

    // CCRuntime peer-pods (required for CAA)
    const ccRuntime = new k8s.kustomize.v2.Directory("cc-runtime-peer-pods", {
      directory: `https://github.com/confidential-containers/operator//config/samples/ccruntime/peer-pods?ref=${opRef}`,
    }, { parent: this, dependsOn: [operatorRelease] });

    // Cloud API Adaptor (CAA) for GCP
    const wantCaa = args.cloudApiAdapter?.enabled !== false;
    let gsaEmailOut: pulumi.Output<string> | undefined = undefined;
    let gsaResourceIdOut: pulumi.Output<string> | undefined = undefined;
    const ksaName = args.cloudApiAdapter?.ksaName || "cloud-api-adaptor";
    this.ksaName = ksaName;

    if (wantCaa) {
      // IAM and WI
      const cfg = new pulumi.Config("gcp");
      const projectId = cfg.require("project");
      const rolesProject = args.cloudApiAdapter?.rolesProjectId || projectId;
      const normalizeAccountId = (raw: string): string => {
        let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        if (!/^[a-z]/.test(s)) s = `a-${s}`;
        if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
        if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
        return s;
      };

      if (args.cloudApiAdapter?.gsaEmail) {
        gsaEmailOut = pulumi.output(args.cloudApiAdapter.gsaEmail);
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

      const wi = args.cloudApiAdapter?.workloadIdentity !== false;
      if (wi && (gsaResourceIdOut || gsaEmailOut)) {
        new gcp.serviceaccount.IAMMember(`${name}-caa-wi`, {
          serviceAccountId: (gsaResourceIdOut || pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut!}`),
          role: "roles/iam.workloadIdentityUser",
          member: pulumi.interpolate`serviceAccount:${projectId}.svc.id.goog[${caaNs}/${ksaName}]`,
        }, { parent: this });
      }

      // Build CAA kustomize with env overrides for TDX/SEV
      const caaVersion = args.cloudApiAdapter?.version || releaseVersion;
      const caaRef = caaVersion.startsWith('v') ? caaVersion : `v${caaVersion}`;
      const podvmInstanceType = args.cloudApiAdapter?.podVm?.instanceType || "c3-standard-4";
      const podvmDisableCvm = args.cloudApiAdapter?.podVm?.disableCvm === true ? "true" : "false";
      const gcpConfidentialType = (args.cloudApiAdapter?.podVm?.confidentialType || "TDX").toUpperCase();
      const gcpDiskType = args.cloudApiAdapter?.podVm?.diskType || (gcpConfidentialType === "TDX" ? "pd-balanced" : "pd-standard");
      const extraEnv = args.cloudApiAdapter?.podVm?.extraEnv || {};
      const caaDir = new k8s.kustomize.Directory("cc-cloud-api-adaptor", {
        directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/cloud-api-adaptor/install/overlays/gcp?ref=${caaRef}`,
        transformations: [
          (obj: any) => {
            if (!obj || !obj.kind || !obj.metadata) return;
            // Keep only ConfigMap updates; upstream overlay handles other resources
            if (obj.kind === "ConfigMap" && obj.metadata.name === "peer-pods-cm") {
              obj.metadata.namespace = caaNs;
              obj.data = obj.data || {};
              obj.data["CLOUD_PROVIDER"] = "gcp";
              obj.data["GCP_PROJECT_ID"] = projectId;
              obj.data["GCP_MACHINE_TYPE"] = podvmInstanceType;
              obj.data["GCP_CONFIDENTIAL_TYPE"] = gcpConfidentialType;
              obj.data["GCP_DISK_TYPE"] = gcpDiskType;
              obj.data["DISABLECVM"] = podvmDisableCvm;
              if (args.cloudApiAdapter?.podVm?.imageName) {
                obj.data["PODVM_IMAGE_NAME"] = args.cloudApiAdapter.podVm.imageName;
              }
              if (args.cloudApiAdapter?.gcpZone) obj.data["GCP_ZONE"] = args.cloudApiAdapter.gcpZone;
              else if (extraEnv["GCP_ZONE"]) obj.data["GCP_ZONE"] = String(extraEnv["GCP_ZONE"]);
              if (extraEnv["GCP_NETWORK"]) obj.data["GCP_NETWORK"] = String(extraEnv["GCP_NETWORK"]);
            }
            // Image override for the rendered DaemonSet (Option B)
            if (obj.kind === "DaemonSet") {
              const tpl = obj.spec && obj.spec.template;
              const spec = tpl && tpl.spec;
              if (!spec) return;
              const containers = Array.isArray(spec.containers) ? spec.containers : [];
              if (containers.length === 0) return;
              let idx = containers.findIndex((c: any) => c && c.name === "cloud-api-adaptor-con");
              if (idx < 0) idx = 0;
              const c = containers[idx];
              const defaultRepo = "quay.io/confidential-containers/cloud-api-adaptor";
              const rawVersion = args.cloudApiAdapter?.version || caaVersion;
              const tagBase = rawVersion && rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
              const defaultTag = `${tagBase}-amd64`;
              const repo = args.cloudApiAdapter?.containerImage?.repository || defaultRepo;
              const tag = args.cloudApiAdapter?.containerImage?.tag || defaultTag;
              c.image = `${repo}:${tag}`;
              if (args.cloudApiAdapter?.containerImage?.pullPolicy) {
                c.imagePullPolicy = args.cloudApiAdapter.containerImage.pullPolicy;
              }
            }
            // No Deployment-level transformation; upstream overlay manages workload manifests
          },
        ],
      }, { parent: this, dependsOn: [ccRuntime] });

      // Inject credentials secret if provided
      if (args.cloudApiAdapter?.gcpCredentialsJson) {
        new k8s.core.v1.Secret("peer-pods-secret", {
          metadata: { name: "peer-pods-secret", namespace: caaNs },
          stringData: { GCP_CREDENTIALS: args.cloudApiAdapter.gcpCredentialsJson },
        }, { parent: this, dependsOn: [caaDir] });
      }

      // Optional extra overlays
      if (args.cloudApiAdapter?.extraKustomize && args.cloudApiAdapter.extraKustomize.length > 0) {
        args.cloudApiAdapter.extraKustomize.forEach((u, idx) => {
          new k8s.kustomize.v2.Directory(`cc-extra-${idx}`, { directory: u }, { parent: this, dependsOn: [caaDir] });
        });
      }

      // Peerpod controller for garbage collecting PodVMs (apply after CAA) via kustomize Directory
      const peerpodController = new k8s.kustomize.Directory("peerpod-controller", {
        directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/peerpod-ctrl/config/default?ref=${caaRef}`,
      }, { parent: this, dependsOn: [caaDir] });

      // Removed DeploymentPatch in favor of kustomize transformations

      // Annotate KSA for Workload Identity (patch)
      if (wi && gsaEmailOut) {
        new k8s.core.v1.ServiceAccountPatch("cloud-api-adaptor-ksa-annotate", {
          metadata: {
            name: ksaName,
            namespace: caaNs,
            annotations: { 'iam.gke.io/gcp-service-account': gsaEmailOut as any },
          },
        }, { parent: this, dependsOn: [peerpodController] });
      }
    }

    this.registerOutputs({
      operatorNamespace: this.operatorNamespace,
      cloudApiAdapterNamespace: this.cloudApiAdapterNamespace,
      gsaEmail: this.gsaEmail,
      ksaName: this.ksaName,
    });
  }
}
