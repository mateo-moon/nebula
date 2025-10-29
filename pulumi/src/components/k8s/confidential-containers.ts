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
  gcpZone?: string | pulumi.Output<string>;                  // sets GCP_ZONE in peer-pods-cm
  gcpNetwork?: string | pulumi.Output<string>;                // sets GCP_NETWORK in peer-pods-cm
  gcpSubnetwork?: string | pulumi.Output<string>;            // sets GCP_SUBNETWORK in peer-pods-cm (for custom subnet mode)
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

    // CCRuntime peer-pods (required for CAA)
    const ccRuntime = new k8s.kustomize.v2.Directory("cc-runtime-peer-pods", {
      directory: `https://github.com/confidential-containers/operator//config/samples/ccruntime/peer-pods?ref=${opRef}`,
    }, { parent: this, dependsOn: [operatorRelease], transforms: [
      (obj: any) => {
        if (!obj || !obj.kind || !obj.metadata) return;
        // Add tolerations for system nodes
        const podLike = (o: any) => o && o.spec && (o.kind === 'Deployment' || o.kind === 'DaemonSet' || o.kind === 'StatefulSet');
        if (podLike(obj)) {
          const tpl = obj.spec.template || (obj.spec.template = {});
          const spec = tpl.spec || (tpl.spec = {});
          // Add tolerations for system nodes
          if (spec.tolerations === undefined) {
            spec.tolerations = [
              { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
            ];
          }
        }
        return obj;
      }
    ] });

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
      const zoneFromConfig = cfg.get("zone");
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

      // Create service account key for credentials
      // Note: This requires overriding the org policy constraint: constraints/iam.disableServiceAccountKeyCreation
      const gsaKey = new gcp.serviceaccount.Key(`${name}-caa-key`, {
        serviceAccountId: gsaResourceIdOut || pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut!}`,
      }, { parent: this });

      // Create the Secret BEFORE kustomize - this way kustomize's secretsGenerator won't create it
      // Use deleteBeforeReplace to handle conflicts with any existing Secret
      // The key must be GCP_CREDENTIALS (not creds.json) because envFrom creates env vars named after the key
      const gcpCredentialsSecret = new k8s.core.v1.Secret(`${name}-caa-gcp-creds`, {
        metadata: {
          name: "peer-pods-secret",
          namespace: namespace,
        },
        type: "Opaque",
        data: {
          "GCP_CREDENTIALS": gsaKey.privateKey.apply(key => key),
        },
      }, { 
        parent: this,
        deleteBeforeReplace: true,
        retainOnDelete: false,
      });

      const wi = args.cloudApiAdapter?.workloadIdentity !== false;
      if (wi && (gsaResourceIdOut || gsaEmailOut)) {
        new gcp.serviceaccount.IAMMember(`${name}-caa-wi`, {
          serviceAccountId: (gsaResourceIdOut || pulumi.interpolate`projects/${projectId}/serviceAccounts/${gsaEmailOut!}`),
          role: "roles/iam.workloadIdentityUser",
          member: pulumi.interpolate`serviceAccount:${projectId}.svc.id.goog[${namespace}/${ksaName}]`,
        }, { parent: this });
      }

      // Build CAA kustomize with env overrides for TDX/SEV
      const caaVersion = args.cloudApiAdapter?.version || releaseVersion;
      // Handle branch names (like 'main') vs version tags (like 'v0.16.0')
      const caaRef = caaVersion.startsWith('v') || caaVersion === 'main' || caaVersion.includes('/') 
        ? caaVersion 
        : `v${caaVersion}`;
      const podvmInstanceType = args.cloudApiAdapter?.podVm?.instanceType || "c3-standard-4";
      const podvmDisableCvm = args.cloudApiAdapter?.podVm?.disableCvm === true ? "true" : "false";
      const gcpConfidentialType = (args.cloudApiAdapter?.podVm?.confidentialType || "TDX").toUpperCase();
      const gcpDiskType = args.cloudApiAdapter?.podVm?.diskType || (gcpConfidentialType === "TDX" ? "pd-balanced" : "pd-standard");
      // Default image name (can be overridden with full path for cross-project support)
      // Cross-project images work with cloud-api-adaptor main branch (fix merged in PR #2654)
      const podvmImageName = args.cloudApiAdapter?.podVm?.imageName || "fedora-mkosi-tee-amd-1-11-0";
      const gcpZoneRaw = args.cloudApiAdapter?.gcpZone || zoneFromConfig;
      const gcpNetworkRaw = args.cloudApiAdapter?.gcpNetwork;
      const gcpSubnetworkRaw = args.cloudApiAdapter?.gcpSubnetwork;
      const containerImage = args.cloudApiAdapter?.containerImage;
      const imageOverride = containerImage?.repository && containerImage?.tag
        ? `${containerImage.repository}:${containerImage.tag}`
        : undefined;
      
      const caaDir = new k8s.kustomize.v2.Directory("cc-cloud-api-adaptor", {
        directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/cloud-api-adaptor/install/overlays/gcp?ref=${caaRef}`,
      }, {
        parent: this,
        dependsOn: [ccRuntime, gcpCredentialsSecret],
        transforms: [
          (obj: any) => {
            // Return early if null
            if (!obj) return obj;
            
            // Handle both direct objects and objects wrapped in metadata
            let resource = obj;
            if (obj.metadata && obj.metadata.name) {
              resource = obj;
            } else if (obj.props) {
              resource = obj.props;
            }
            
            // Filter out Secret - we create it ourselves  
            if (resource?.kind === "Secret" && resource?.metadata?.name === "peer-pods-secret") {
              return undefined;
            }
            
            // Access the actual Kubernetes resource from props
            const k8sObj = obj?.props || obj;
            if (!k8sObj || !k8sObj.kind || !k8sObj.metadata) return obj;
            
            // Update ConfigMap with our values
            if (k8sObj.kind === "ConfigMap" && k8sObj.metadata.name === "peer-pods-cm") {
              k8sObj.data = k8sObj.data || {};
              k8sObj.data["CLOUD_PROVIDER"] = "gcp";
              k8sObj.data["GCP_PROJECT_ID"] = projectId || "";
              k8sObj.data["GCP_MACHINE_TYPE"] = podvmInstanceType || "";
              k8sObj.data["GCP_CONFIDENTIAL_TYPE"] = gcpConfidentialType || "";
              k8sObj.data["GCP_DISK_TYPE"] = gcpDiskType || "";
              k8sObj.data["DISABLECVM"] = podvmDisableCvm || "false";
              k8sObj.data["PODVM_IMAGE_NAME"] = podvmImageName || "";
              k8sObj.data["GCP_ZONE"] = typeof gcpZoneRaw === 'string' ? gcpZoneRaw : "";
              
              // Handle GCP_NETWORK: convert relative paths to full URLs
              const currentNetwork = k8sObj.data["GCP_NETWORK"] || "global/networks/default";
              if (typeof gcpNetworkRaw === 'string') {
                // Use the provided string value
                k8sObj.data["GCP_NETWORK"] = gcpNetworkRaw;
              } else if (currentNetwork.startsWith("global/networks/") || currentNetwork.startsWith("networks/")) {
                // Convert kustomize default to full URL
                const networkName = currentNetwork.split("/").pop() || "default";
                k8sObj.data["GCP_NETWORK"] = `https://www.googleapis.com/compute/v1/projects/${projectId}/global/networks/${networkName}`;
              }
              
              // Set GCP_SUBNETWORK if it's a string (not an Output)
              if (typeof gcpSubnetworkRaw === 'string') {
                k8sObj.data["GCP_SUBNETWORK"] = gcpSubnetworkRaw;
              }
            }
            // Add tolerations for system nodes and override container image
            const podLike = (o: any) => o && o.spec && (o.kind === 'Deployment' || o.kind === 'DaemonSet' || o.kind === 'StatefulSet');
            if (podLike(k8sObj)) {
              const tpl = k8sObj.spec.template || (k8sObj.spec.template = {});
              const spec = tpl.spec || (tpl.spec = {});
              
              // Add tolerations for system nodes
              if (spec.tolerations === undefined) {
                spec.tolerations = [
                  { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' },
                ];
              }
              
              // Override container image if specified
              if (spec.containers) {
                for (const container of spec.containers) {
                  // Match cloud-api-adaptor by name or by old registry in image
                  const isCaaContainer = container.name?.includes("cloud-api-adaptor") || 
                                         container.image?.includes("192.168.122.1:5000") ||
                                         container.image === "cloud-api-adaptor";
                  
                  if (isCaaContainer) {
                    if (imageOverride) {
                      container.image = imageOverride;
                    }
                    // Always set pullPolicy if provided
                    if (containerImage?.pullPolicy) {
                      container.imagePullPolicy = containerImage.pullPolicy;
                    }
                    // Note: SecretRef to peer-pods-secret is kept as-is
                    // We create this secret above with the proper structure
                    // The key is GCP_CREDENTIALS because envFrom creates env vars named after the key
                  }
                }
              }
            }
            return obj;
          }
        ]
      });
      
      const caaDirResult = caaDir;

      // Optional extra overlays
      if (args.cloudApiAdapter?.extraKustomize && args.cloudApiAdapter.extraKustomize.length > 0) {
        args.cloudApiAdapter.extraKustomize.forEach((u, idx) => {
          new k8s.kustomize.v2.Directory(`cc-extra-${idx}`, { directory: u }, { parent: this, dependsOn: [caaDirResult] });
        });
      }

      // Peerpod controller for garbage collecting PodVMs (apply after CAA) via kustomize Directory
      const peerpodController = new k8s.kustomize.v2.Directory("peerpod-controller", {
        directory: `https://github.com/confidential-containers/cloud-api-adaptor//src/peerpod-ctrl/config/default?ref=${caaRef}`,
      }, {
        parent: this,
        dependsOn: [caaDirResult, gcpCredentialsSecret],
      });

      // Annotate KSA for Workload Identity (patch)
      if (wi && gsaEmailOut) {
        new k8s.core.v1.ServiceAccountPatch("cloud-api-adaptor-ksa-annotate", {
          metadata: {
            name: ksaName,
            namespace: namespace,
            annotations: { 'iam.gke.io/gcp-service-account': gsaEmailOut as any },
          },
        }, { parent: this, dependsOn: [peerpodController] });
      }
    }

    this.registerOutputs({
      operatorNamespace: namespace,
      cloudApiAdapterNamespace: namespace,
      gsaEmail: this.gsaEmail,
      ksaName: this.ksaName,
    });
  }
}
