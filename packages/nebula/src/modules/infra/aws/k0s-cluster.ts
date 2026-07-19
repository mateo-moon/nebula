import * as crypto from "crypto";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { DEFAULT_NODE_INSTANCE_PROFILE } from "./iam";
import {
  DEFAULT_PRESTART_COMMANDS,
  emitClusterCr,
  emitAwsClusterCr,
  emitAwsMachineTemplate,
} from "./_shared";
import { K0sControlPlaneV1Beta2 } from "#imports/controlplane.cluster.x-k8s.io";
import {
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
} from "#imports/infrastructure.cluster.x-k8s.io";

export interface AwsK0sControlPlaneOptions {
  /** Number of control-plane nodes (default 3 for HA) */
  replicas?: number;
  /**
   * EC2 instance type for control-plane nodes (default "t4g.large" — arm64
   * Graviton2, ~40% cheaper than x86 m6i.large for the same 2 vCPU / 8 GiB).
   * The whole mgmt stack (k0s, Crossplane, CAPA/k0smotron, cert-manager) ships
   * arm64 images. Pair with an arm64 AMI (e.g. Ubuntu 22.04 arm64); a t4g/m*g
   * instance with an x86 AMI will fail to boot.
   */
  instanceType?: string;
  /** Root volume size in GiB (default 80) */
  rootVolumeSizeGiB?: number;
  /** Root volume type (default "gp3") */
  rootVolumeType?: string;
  /**
   * Run workloads on the control-plane nodes (k0s combined controller+worker
   * role). Default true — for a small management cluster the 3 CP nodes also
   * host Crossplane/CAPI/ArgoCD and the k0smotron hosted control planes.
   */
  enableWorker?: boolean;
  /** Extra k0s controller args */
  extraArgs?: string[];
  /**
   * AMI selection. Recommend setting `id` to a region-specific Ubuntu 22.04 AMI
   * (k0s is installed via cloud-init). Falls back to CAPA's image lookup.
   */
  ami?: {
    id?: string;
    lookupOrg?: string;
    lookupBaseOs?: string;
    lookupFormat?: string;
  };
  /** Extra cloud-init preStartCommands appended to the defaults */
  extraPreStartCommands?: string[];
}

export interface AwsK0sClusterConfig {
  /** Cluster name */
  name: string;
  /** AWS region */
  region: string;
  /** Namespace for CAPI objects (default "default") */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is derived from it */
  k8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16") */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12") */
  serviceCidr?: string;
  /** VPC CIDR CAPA will create (default "10.0.0.0/16") */
  vpcCidr?: string;
  /**
   * Cap the number of AZs CAPA spreads subnets across. CAPA creates one NAT
   * gateway + Elastic IP per AZ; set to 1 on EIP-constrained accounts (single-AZ,
   * 1 NAT/EIP — no AZ-level HA). Omitted = CAPA default (up to 3 AZs).
   */
  availabilityZoneUsageLimit?: number;
  /**
   * Secondary IPv4 CIDR block(s) to associate with the managed VPC, e.g.
   * ["10.1.0.0/16"]. Use when the primary vpcCidr is fully tiled by existing subnets
   * and you need address space for additional-AZ subnets on a LIVE cluster (CAPA
   * associates these on the existing VPC, then creates subnets carved from them).
   */
  secondaryCidrBlocks?: string[];
  /**
   * Explicit subnet set (the FULL list: existing + new) to grow a live cluster's AZ
   * coverage. CAPA adopts existing subnets by AZ+CIDR and creates the rest — so list
   * the existing subnets at their exact CIDR/AZ. Omitted = CAPA auto-derives subnets
   * from availabilityZoneUsageLimit (which only applies at VPC creation).
   */
  subnets?: Array<{
    availabilityZone: string;
    cidrBlock: string;
    isPublic: boolean;
    /** Logical id (CAPA convention: `<cluster>-subnet-<public|private>-<az>`). */
    id: string;
  }>;
  /** Pre-existing EC2 key pair name for SSH access to nodes */
  sshKeyName?: string;
  /**
   * Name of the IAM instance profile for the nodes (created by `Aws`/`AwsIam`).
   * Defaults to CAPA's conventional 'nodes.cluster-api-provider-aws.sigs.k8s.io'.
   */
  iamInstanceProfile?: string;
  /** Control-plane configuration */
  controlPlane?: AwsK0sControlPlaneOptions;
  /**
   * Make the cluster KEYLESS-capable: emit `instanceMetadataOptions` (IMDSv2,
   * hop limit 2) on the control-plane AWSMachineTemplate so pod-networked
   * controllers (Crossplane provider-aws, CAPA) on the control-plane nodes can
   * reach IMDS and authenticate via the node instance profile. Pair with
   * `Aws`/`AwsIam` `controllerPolicies` (instance-profile carries the perms) and
   * keyless ProviderConfig/CAPA creds. Off by default. NOTE: this is part of the
   * immutable AWSMachineTemplate spec — enabling it on an already-running cluster
   * forces a control-plane machine roll, so set it at cluster creation.
   */
  imdsPodAccess?: boolean;
  /**
   * Configure the kube-apiserver as an OIDC issuer for IRSA/WebIdentity (so AWS
   * STS can validate this cluster's projected service-account tokens). `issuerUrl`
   * is the PUBLIC HTTPS base URL hosting the OIDC discovery + JWKS (a public S3
   * bucket); it becomes the token `iss` claim and must match the AWS IAM OIDC
   * provider URL byte-for-byte (regional virtual-hosted S3 host, no trailing
   * slash). Sets `--service-account-issuer` + `--service-account-jwks-uri` on the
   * apiserver. MUST be set at cluster creation (changing it later rolls the
   * control plane and changes `iss`). The discovery docs are published to S3
   * out-of-band (the bootstrap's setupIrsa step). `api-audiences` is left at its
   * default (= the issuer) so in-cluster SA auth is unaffected; the
   * sts.amazonaws.com audience is minted per projected-token-volume via TokenRequest.
   */
  oidcIssuer?: { issuerUrl: string };
  /**
   * Scheme of the control-plane Network Load Balancer. Defaults to INTERNAL so
   * the k0s API endpoint is not exposed to the internet (mTLS still guards it).
   * Set to `AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNET_HYPHEN_FACING`
   * ("internet-facing") to publish the API publicly.
   */
  controlPlaneLoadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
  /**
   * CNI for the embedded k0s ClusterConfig (`spec.network.provider`). Defaults to
   * `"kuberouter"` (k0s's built-in CNI). Set to `"custom"` to make k0s install NO
   * CNI, so a CNI is deployed separately (e.g. the `Calico` module owns pod
   * networking + the encrypted node mesh).
   * **Immutable at cluster creation**: switching the CNI on a running cluster is a
   * disruptive pod re-IP migration, so pick this on a FRESH bootstrap.
   */
  networkProvider?: "kuberouter" | "calico" | "custom";
  /**
   * k0s-bundled Calico settings, emitted into `spec.network.calico` ONLY when
   * `networkProvider` is `"calico"`. Defaults to `mode: "vxlan"` (no BGP — works
   * on any L2/L3 underlay incl. AWS). `wireguard: true` enables encrypted
   * node-to-node pod traffic — inert on a single node, active once there are
   * multiple nodes. Set it at create so it's already in the cluster's k0s config
   * when you scale (changing the k0sConfigSpec later rolls the control plane).
   */
  calico?: {
    wireguard?: boolean;
    mode?: "vxlan" | "ipip" | "bird";
    mtu?: number;
  };
}

/**
 * AwsK0sCluster - a self-managed, HA k0s cluster on AWS EC2 via Cluster API,
 * with a **standalone** control plane (etcd + k0s controllers on the cluster's
 * own EC2 nodes). This is the **vendor-free management cluster**: no EKS, no
 * managed control plane.
 *
 * Uses a **standalone** k0smotron control plane (not hosted):
 *  - control plane is `K0sControlPlane` (runs on the cluster's nodes), so it is
 *    self-contained and persistent — it can host other clusters' control planes.
 *  - the AWSCluster's control-plane LoadBalancer is **enabled** (an NLB) for a
 *    stable API endpoint. Defaults to an **internal** scheme; set
 *    `controlPlaneLoadBalancerScheme` to expose it publicly.
 *
 * By default the control-plane nodes run in combined controller+worker mode so a
 * small (3-node) cluster also hosts Crossplane/CAPI/ArgoCD. CNI defaults to k0s's
 * built-in kube-router; set `networkProvider: "custom"` to make k0s install no CNI
 * and own networking with the `Calico` module (its wireguard mode = encrypted node mesh).
 *
 * The IAM instance profile must pre-exist — create it with `Aws`/`AwsIam`.
 */
export class AwsK0sCluster extends BaseConstruct<AwsK0sClusterConfig> {
  constructor(scope: Construct, id: string, config: AwsK0sClusterConfig) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const k0sVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const vpcCidr = this.config.vpcCidr ?? "10.0.0.0/16";
    const cp = this.config.controlPlane ?? {};
    const networkProvider = this.config.networkProvider ?? "kuberouter";
    const calico = this.config.calico ?? {};
    const iamInstanceProfile =
      this.config.iamInstanceProfile ?? DEFAULT_NODE_INSTANCE_PROFILE;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;
    // CAPA AWSMachineTemplate spec is IMMUTABLE — the admission webhook rejects any
    // in-place edit, so a fixed template name can NEVER change disk/instanceType/AMI/
    // IMDS on a running cluster. Derive the name from a hash of the template spec
    // instead: any spec change yields a new name, CAPA creates a fresh template, and
    // the K0sControlPlane's infrastructureRef repoints to it — which rolls the nodes
    // (the standard CAPI rotate-on-change pattern). A no-op synth hashes identically,
    // so steady state does not churn. The K0sControlPlane name stays stable (only the
    // infra template rotates), so the pivot-adopted CP object is untouched.
    const cpTemplateSpec = {
      instanceType: cp.instanceType ?? "t4g.large",
      iamInstanceProfile,
      sshKeyName: this.config.sshKeyName ?? null,
      rootVolumeSizeGiB: cp.rootVolumeSizeGiB ?? 80,
      rootVolumeType: cp.rootVolumeType ?? "gp3",
      ami: cp.ami ?? null,
      imdsPodAccess: this.config.imdsPodAccess ?? false,
    };
    const cpTemplateHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(cpTemplateSpec))
      .digest("hex")
      .slice(0, 8);
    const cpMachineTemplateName = `${name}-control-plane-${cpTemplateHash}`;

    // 1. Cluster-API Cluster
    emitClusterCr(this, {
      clusterName,
      namespace,
      podCidr,
      serviceCidr,
      controlPlaneKind: "K0sControlPlane",
      controlPlaneName,
    });

    // 2. AWSCluster - CAPA owns the VPC/subnets/SGs. The control-plane LB is an
    //    NLB for a stable API endpoint; default INTERNAL so it is not exposed to
    //    the internet (override via controlPlaneLoadBalancerScheme).
    emitAwsClusterCr(this, {
      clusterName,
      namespace,
      region: this.config.region,
      sshKeyName: this.config.sshKeyName,
      loadBalancerType:
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.NLB,
      loadBalancerScheme:
        this.config.controlPlaneLoadBalancerScheme ??
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNAL,
      vpcCidr,
      availabilityZoneUsageLimit: this.config.availabilityZoneUsageLimit,
      secondaryCidrBlocks: this.config.secondaryCidrBlocks,
      subnets: this.config.subnets,
    });

    // 3. AWSMachineTemplate for the control-plane nodes
    emitAwsMachineTemplate(this, "control-plane-template", {
      name: cpMachineTemplateName,
      namespace,
      instanceType: cp.instanceType ?? "t4g.large",
      iamInstanceProfile,
      publicIp: false,
      sshKeyName: this.config.sshKeyName,
      rootVolumeSizeGiB: cp.rootVolumeSizeGiB ?? 80,
      rootVolumeType: cp.rootVolumeType ?? "gp3",
      ami: cp.ami,
      // Keyless mgmt control plane: let controller pods reach IMDS (IMDSv2, hop 2).
      imdsPodAccess: this.config.imdsPodAccess,
    });

    // 4. K0sControlPlane - standalone HA control plane on the EC2 nodes.
    const enableWorker = cp.enableWorker !== false;
    const args = [
      ...(enableWorker ? ["--enable-worker", "--no-taints"] : []),
      ...(cp.extraArgs ?? []),
    ];
    new K0sControlPlaneV1Beta2(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        replicas: cp.replicas ?? 3,
        version: k0sVersion,
        k0SConfigSpec: {
          ...(args.length ? { args } : {}),
          // Propagate the pod/service CIDRs into the embedded k0s ClusterConfig
          // so the real control plane matches the CAPI clusterNetwork above.
          // Without this, k0s falls back to its own defaults whenever a caller
          // overrides podCidr/serviceCidr. The CNI is selected by `networkProvider`
          // ("kuberouter" default; "custom" makes k0s install NO CNI so the Calico
          // module owns networking + the encrypted node mesh).
          k0S: {
            apiVersion: "k0s.k0sproject.io/v1beta1",
            kind: "ClusterConfig",
            spec: {
              network: {
                provider: networkProvider,
                // k0s-bundled Calico tuning (only meaningful for provider=calico):
                // vxlan overlay (no BGP) + optional wireguard node-mesh encryption.
                ...(networkProvider === "calico"
                  ? {
                      calico: {
                        mode: calico.mode ?? "vxlan",
                        wireguard: calico.wireguard ?? false,
                        ...(calico.mtu ? { mtu: calico.mtu } : {}),
                      },
                    }
                  : {}),
                podCIDR: podCidr,
                serviceCIDR: serviceCidr,
              },
              // OIDC issuer for IRSA: point the apiserver's service-account issuer
              // at the public S3-hosted discovery so AWS STS can validate this
              // cluster's projected SA tokens. extraArgs is a map (single issuer).
              ...(this.config.oidcIssuer
                ? {
                    api: {
                      extraArgs: {
                        "service-account-issuer": this.config.oidcIssuer.issuerUrl,
                        "service-account-jwks-uri": `${this.config.oidcIssuer.issuerUrl}/keys.json`,
                      },
                    },
                  }
                : {}),
            },
          },
          // k0smotron v1beta2 renamed bootstrap `preStartCommands` → `preK0sCommands`
          // (generated TS property `preK0SCommands`).
          preK0SCommands: [
            ...DEFAULT_PRESTART_COMMANDS,
            ...(cp.extraPreStartCommands ?? []),
          ],
        },
        machineTemplate: {
          infrastructureRef: {
            apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
            kind: "AWSMachineTemplate",
            name: cpMachineTemplateName,
          },
        },
      },
    });
  }
}
