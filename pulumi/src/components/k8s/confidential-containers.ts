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
  gcpNetwork?: string;                // sets GCP_NETWORK in peer-pods-cm
  extraKustomize?: string[];         // additional kustomize URLs to apply
}

export interface ConfidentialContainersConfig {
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
  public readonly gsaEmail?: pulumi.Output<string>;
  public readonly ksaName?: string;

  constructor(name: string, args: ConfidentialContainersConfig, opts?: pulumi.ComponentResourceOptions) {
    super("confidential-containers", name, args, opts);

    const releaseVersion = args.operator?.version || "v0.16.0";
    const namespace = "confidential-containers-system";



    // Operator (release) via kustomize Directory (use kustomize remote ref syntax: repo//path?ref=tag)
    const opRef = releaseVersion.startsWith('v') ? releaseVersion : `v${releaseVersion}`;
    const operatorRelease = new k8s.kustomize.v2.Directory("cc-operator-release", {
      directory: `https://github.com/confidential-containers/operator//config/release?ref=${opRef}`,
    }, { parent: this });

    // // CCRuntime peer-pods (required for CAA)
    // const ccRuntime = new k8s.kustomize.v2.Directory("cc-runtime-peer-pods", {
    //   directory: `https://github.com/confidential-containers/operator//config/samples/ccruntime/peer-pods?ref=${opRef}`,
    // }, { parent: this, dependsOn: [operatorRelease] });

    // // Cloud API Adaptor (CAA) for GCP
    // const wantCaa = args.cloudApiAdapter?.enabled !== false;
    // let gsaEmailOut: pulumi.Output<string> | undefined = undefined;
    // let gsaResourceIdOut: pulumi.Output<string> | undefined = undefined;
    // const ksaName = args.cloudApiAdapter?.ksaName || "cloud-api-adaptor";
    // this.ksaName = ksaName;

    // if (wantCaa) {
    //   // IAM and WI
    //   const cfg = new pulumi.Config("gcp");
    //   const projectId = cfg.require("project");
    //   const zoneFromConfig = cfg.get("zone");
    //   const rolesProject = args.cloudApiAdapter?.rolesProjectId || projectId;
    //   const normalizeAccountId = (raw: string): string => {
    //     let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    //     if (!/^[a-z]/.test(s)) s = `a-${s}`;
    //     if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
    //     if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
    //     return s;
    //   };

    //   if (args.cloudApiAdapter?.gsaEmail) {
    //     gsaEmailOut = pulumi.output(args.cloudApiAdapter.gsaEmail);
    //     gsaResourceIdOut = pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut}`;
    //     this.gsaEmail = gsaEmailOut;
    //   } else {
    //     const accountId = normalizeAccountId(args.cloudApiAdapter?.gsaName || `${name}-caa`);
    //     const gsa = new gcp.serviceaccount.Account(`${name}-caa-gsa`, {
    //       accountId,
    //       displayName: `${name} Cloud API Adapter`,
    //     }, { parent: this });
    //     gsaEmailOut = gsa.email;
    //     gsaResourceIdOut = gsa.name;
    //     this.gsaEmail = gsaEmailOut;

    //     const defaultRoles = [
    //       "roles/compute.instanceAdmin.v1",
    //       "roles/compute.networkAdmin",
    //       "roles/compute.securityAdmin",
    //       "roles/iam.serviceAccountUser",
    //       "roles/logging.logWriter",
    //       "roles/monitoring.metricWriter",
    //       "roles/secretmanager.secretAccessor",
    //       "roles/storage.objectViewer",
    //     ];
    //     const roles = (args.cloudApiAdapter?.roles && args.cloudApiAdapter.roles.length > 0)
    //       ? args.cloudApiAdapter.roles
    //       : defaultRoles;
    //     roles.forEach((role, idx) => {
    //       new gcp.projects.IAMMember(`${name}-caa-role-${idx}`, {
    //         project: rolesProject,
    //         role,
    //         member: pulumi.interpolate`serviceAccount:${gsa.email}`,
    //       }, { parent: this });
    //     });
    //   }

    //   const wi = args.cloudApiAdapter?.workloadIdentity !== false;
    //   if (wi && (gsaResourceIdOut || gsaEmailOut)) {
    //     new gcp.serviceaccount.IAMMember(`${name}-caa-wi`, {
    //       serviceAccountId: (gsaResourceIdOut || pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut!}`),
    //       role: "roles/iam.workloadIdentityUser",
    //       member: pulumi.interpolate`serviceAccount:${projectId}.svc.id.goog[${namespace}/${ksaName}]`,
    //     }, { parent: this });
    //   }

    //   // Build CAA kustomize with env overrides for TDX/SEV
    //   const caaVersion = args.cloudApiAdapter?.version || releaseVersion;
    //   const caaRef = caaVersion.startsWith('v') ? caaVersion : `v${caaVersion}`;
    //   const podvmInstanceType = args.cloudApiAdapter?.podVm?.instanceType || "c3-standard-4";
    //   const podvmDisableCvm = args.cloudApiAdapter?.podVm?.disableCvm === true ? "true" : "false";
    //   const gcpConfidentialType = (args.cloudApiAdapter?.podVm?.confidentialType || "TDX").toUpperCase();
    //   const gcpDiskType = args.cloudApiAdapter?.podVm?.diskType || (gcpConfidentialType === "TDX" ? "pd-balanced" : "pd-standard");
    //   const podvmImageName = args.cloudApiAdapter?.podVm?.imageName || "/projects/it-cloud-gcp-prod-osc-devel/global/images/fedora-mkosi-tee-amd-1-11-0";
    //   const gcpZone = args.cloudApiAdapter?.gcpZone || zoneFromConfig;
    //   const gcpNetwork = args.cloudApiAdapter?.gcpNetwork || "default";
    //   const caaDir = new k8s.kustomize.v2.Directory("cc-cloud-api-adaptor", {
    //     directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/cloud-api-adaptor/install/overlays/gcp?ref=${caaRef}`,
    //   }, {
    //     parent: this,
    //     dependsOn: [ccRuntime],
    //     transforms: [
    //       (obj: any) => {
    //         if (!obj || !obj.kind || !obj.metadata) return;
    //         // Keep only ConfigMap updates; upstream overlay handles other resources
    //         if (obj.kind === "ConfigMap" && obj.metadata.name === "peer-pods-cm") {
    //           obj.data = obj.data || {};
    //           obj.data["CLOUD_PROVIDER"] = "gcp";
    //           obj.data["GCP_PROJECT_ID"] = projectId;
    //           obj.data["GCP_MACHINE_TYPE"] = podvmInstanceType;
    //           obj.data["GCP_CONFIDENTIAL_TYPE"] = gcpConfidentialType;
    //           obj.data["GCP_DISK_TYPE"] = gcpDiskType;
    //           obj.data["DISABLECVM"] = podvmDisableCvm;
    //           obj.data["PODVM_IMAGE_NAME"] = podvmImageName;
    //           obj.data["GCP_ZONE"] = gcpZone;
    //           obj.data["GCP_NETWORK"] = gcpNetwork;
    //         }
    //         return obj;
    //       }
    //     ]
    //   });

    //   // Optional extra overlays
    //   if (args.cloudApiAdapter?.extraKustomize && args.cloudApiAdapter.extraKustomize.length > 0) {
    //     args.cloudApiAdapter.extraKustomize.forEach((u, idx) => {
    //       new k8s.kustomize.v2.Directory(`cc-extra-${idx}`, { directory: u }, { parent: this, dependsOn: [caaDir] });
    //     });
    //   }

    //   // Peerpod controller for garbage collecting PodVMs (apply after CAA) via kustomize Directory
    //   const peerpodController = new k8s.kustomize.v2.Directory("peerpod-controller", {
    //     directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/peerpod-ctrl/config/default?ref=${caaRef}`,
    //   }, {
    //     parent: this,
    //     dependsOn: [caaDir],
    //   });

    //   // Annotate KSA for Workload Identity (patch)
    //   if (wi && gsaEmailOut) {
    //     new k8s.core.v1.ServiceAccountPatch("cloud-api-adaptor-ksa-annotate", {
    //       metadata: {
    //         name: ksaName,
    //         namespace: namespace,
    //         annotations: { 'iam.gke.io/gcp-service-account': gsaEmailOut as any },
    //       },
    //     }, { parent: this, dependsOn: [peerpodController] });
    //   }
    // }

    this.registerOutputs({
      operatorNamespace: namespace,
      cloudApiAdapterNamespace: namespace,
      gsaEmail: this.gsaEmail,
      ksaName: this.ksaName,
    });
  }
}
