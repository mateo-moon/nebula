import * as crypto from "crypto";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { DEFAULT_NODE_INSTANCE_PROFILE } from "./iam";
import {
  DEFAULT_PRESTART_COMMANDS,
  emitClusterCr,
  emitAwsClusterCr,
  emitAwsMachineTemplate,
  NodeIngressRuleSpec,
  SpotSelection,
} from "./_shared";
import { MachineDeploymentV1Beta1 } from "#imports/cluster.x-k8s.io";
import {
  K0smotronControlPlane,
  K0SmotronControlPlaneSpecServiceType,
  K0SmotronControlPlaneSpecPersistence,
  K0SmotronControlPlaneSpecPersistencePersistentVolumeClaimSpecResourcesRequests,
} from "#imports/controlplane.cluster.x-k8s.io";
import { K0sWorkerConfigTemplateV1Beta2 } from "#imports/bootstrap.cluster.x-k8s.io";
import { AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType } from "#imports/infrastructure.cluster.x-k8s.io";

export interface AwsWorkloadClusterWorkers {
  /** Number of worker nodes (static — no autoscaler) */
  replicas?: number;
  /** EC2 instance type (default "m6i.large") */
  instanceType?: string;
  /** Root volume size in GiB (default 80) */
  rootVolumeSizeGiB?: number;
  /** Root volume type (default "gp3") */
  rootVolumeType?: string;
  /** Assign a public IP (default false — nodes live in private subnets behind NAT) */
  publicIp?: boolean;
  /**
   * AMI selection. Strongly recommend setting `id` to a region-specific Ubuntu
   * AMI; k0s is installed via cloud-init so a clean Ubuntu image is ideal.
   * If omitted, CAPA's default image lookup is used (may not suit k0s).
   */
  ami?: {
    id?: string;
    lookupOrg?: string;
    lookupBaseOs?: string;
    lookupFormat?: string;
  };
  /** Extra cloud-init preStartCommands appended to the defaults */
  extraPreStartCommands?: string[];
  /** Failure domain / AZ hint for the MachineDeployment */
  failureDomain?: string;
  /**
   * Run this pool's instances as EC2 Spot. `true` (or `{}`) caps the bid at
   * the on-demand price; `{ maxPrice: "0.20" }` sets an explicit USD/hour cap.
   * Spot nodes can be reclaimed with a 2-minute notice — only use for pools
   * that tolerate node loss. Default off (on-demand).
   */
  spot?: SpotSelection;
  /**
   * Node labels applied at registration via the native `k0s worker
   * --labels=k=v,...` flag (rendered into the K0sWorkerConfigTemplate args).
   */
  nodeLabels?: Record<string, string>;
  /**
   * Node taints applied at registration via the native `k0s worker
   * --taints=key=value:Effect,...` flag. Omit `value` for a value-less taint
   * (rendered as `key:Effect`).
   */
  taints?: Array<{
    key: string;
    value?: string;
    effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  }>;
  /**
   * Extra raw `k0s worker` args appended after the generated
   * `--labels`/`--taints` (see https://docs.k0sproject.io/stable/cli/k0s_worker/).
   */
  k0sArgs?: string[];
}

export interface AwsWorkloadClusterConfig {
  /** Cluster name */
  name: string;
  /** AWS region */
  region: string;
  /** Namespace for CAPI objects (default "default") */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); k0s variants are derived from it */
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
  /**
   * Extra ingress rules opened on the NODE security group (CAPA
   * `network.additionalNodeIngressRules`). Use for workloads that need public
   * inbound ports on the workers, e.g. Ethereum P2P (30303 + 9000 tcp/udp from
   * 0.0.0.0/0). Default none — the node SG stays CAPA-default (intra-cluster only).
   */
  additionalNodeIngressRules?: NodeIngressRuleSpec[];
  /** Pre-existing EC2 key pair name for SSH access to nodes */
  sshKeyName?: string;
  /**
   * Name of the worker node IAM instance profile (created by the `Aws`/`AwsIam`
   * construct). Defaults to CAPA's conventional
   * 'nodes.cluster-api-provider-aws.sigs.k8s.io'.
   */
  iamInstanceProfile?: string;
  /** Worker node configuration (the DEFAULT pool — see `workerPools`) */
  workers?: AwsWorkloadClusterWorkers;
  /**
   * Additional named worker pools, each rendering its own AWSMachineTemplate +
   * K0sWorkerConfigTemplate + MachineDeployment named `<cluster>-<pool>`. The
   * pool AWSMachineTemplate name embeds a spec hash (rotate-on-change — CAPA
   * template specs are immutable, see AwsK0sCluster), so instanceType/AMI/spot
   * changes roll the pool's nodes. `workers` keeps working unchanged as the
   * default pool (fixed resource names, so existing clusters are untouched);
   * it is skipped ONLY when `workerPools` is set and `workers` is not.
   */
  workerPools?: Record<string, AwsWorkloadClusterWorkers>;
  /**
   * Service type for the k0smotron control-plane API endpoint. This Service runs
   * in the MANAGEMENT cluster (k0smotron hosts the control plane), so it uses the
   * management cluster's LB — not AWS. Default "LoadBalancer".
   */
  controlPlaneServiceType?: K0SmotronControlPlaneSpecServiceType;
  /** Annotations for the control-plane Service (management-cluster LB specifics) */
  controlPlaneServiceAnnotations?: Record<string, string>;
  /**
   * Persistence for the k0smotron hosted control-plane etcd. Default 'emptyDir'
   * (ephemeral). Use 'pvc' so the etcd survives pod reschedules and is
   * snapshot/restore-able — recommended on a persistent management cluster and
   * what makes a future AWS→GCP control-plane migration practical. Requires a
   * StorageClass on the management cluster (e.g. Longhorn/Piraeus).
   */
  controlPlanePersistence?:
    | { type: "emptyDir" }
    | {
        type: "pvc";
        storageClass?: string;
        size?: string;
        accessModes?: string[];
      };
}

/**
 * AwsWorkloadCluster - a self-managed k0s cluster on AWS EC2 via Cluster API.
 *
 * - k0smotron hosts the control plane as pods in the management cluster.
 * - CAPA owns the AWS networking (VPC/subnets/SGs); the control-plane LB is
 *   DISABLED on the AWSCluster because k0smotron exposes the API itself.
 * - Workers are static `MachineDeployment` replicas (no Karpenter / autoscaler).
 * - CNI is "custom" (Calico installed separately via the `Calico` module).
 *
 * The worker IAM instance profile must pre-exist — create it with `Aws`/`AwsIam`.
 */
export class AwsWorkloadCluster extends BaseConstruct<AwsWorkloadClusterConfig> {
  constructor(scope: Construct, id: string, config: AwsWorkloadClusterConfig) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    // k0smotron expects a SemVer in K0smotronControlPlane.spec.version; the
    // canonical k0s suffix is "+k0s.0" (SemVer build metadata), not "-k0s.0"
    // (which is a pre-release and appears in k0smotron issue #1027 as a bug).
    // Keep this consistent with k0sWorkerVersion and AwsK0sCluster below.
    const k0sControlPlaneVersion = `${k8sVersion}+k0s.0`;
    const k0sWorkerVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const vpcCidr = this.config.vpcCidr ?? "10.0.0.0/16";
    const workers = this.config.workers ?? {};
    const iamInstanceProfile =
      this.config.iamInstanceProfile ?? DEFAULT_NODE_INSTANCE_PROFILE;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;
    const machineTemplateName = `${name}-workers`;
    const workerConfigName = `${name}-worker-config`;

    // 1. Cluster-API Cluster
    emitClusterCr(this, {
      clusterName,
      namespace,
      podCidr,
      serviceCidr,
      controlPlaneKind: "K0smotronControlPlane",
      controlPlaneName,
    });

    // 2. AWSCluster - CAPA owns the VPC/subnets/SGs. Control-plane LB is DISABLED
    //    because k0smotron exposes the API; controlPlaneEndpoint is populated by
    //    k0smotron at runtime.
    emitAwsClusterCr(this, {
      clusterName,
      namespace,
      region: this.config.region,
      sshKeyName: this.config.sshKeyName,
      loadBalancerType:
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.DISABLED,
      vpcCidr,
      availabilityZoneUsageLimit: this.config.availabilityZoneUsageLimit,
      secondaryCidrBlocks: this.config.secondaryCidrBlocks,
      subnets: this.config.subnets,
      additionalNodeIngressRules: this.config.additionalNodeIngressRules,
    });

    // 3. K0smotronControlPlane (hosted in the management cluster)
    const cpPersistence = this.config.controlPlanePersistence;
    const persistence: K0SmotronControlPlaneSpecPersistence =
      cpPersistence?.type === "pvc"
        ? {
            type: "pvc",
            persistentVolumeClaim: {
              spec: {
                accessModes: cpPersistence.accessModes ?? ["ReadWriteOnce"],
                ...(cpPersistence.storageClass
                  ? { storageClassName: cpPersistence.storageClass }
                  : {}),
                resources: {
                  // The generated `requests` map values are a Quantity wrapper
                  // class whose serializer reads `.value`; a bare string renders
                  // `storage: null`. Wrap with the Quantity type so the size is
                  // emitted correctly.
                  requests: {
                    storage:
                      K0SmotronControlPlaneSpecPersistencePersistentVolumeClaimSpecResourcesRequests.fromString(
                        cpPersistence.size ?? "5Gi",
                      ),
                  },
                },
              },
            },
          }
        : { type: "emptyDir" };
    new K0smotronControlPlane(this, "control-plane", {
      metadata: {
        name: controlPlaneName,
        namespace,
        // k0smotron v2.x dropped spec.service.{annotations,labels,...} from its
        // internal v1beta2 API; the controller reads Service annotations ONLY
        // from this JSON-encoded CR annotation (see k0smotron
        // api/k0smotron.io/v1beta1/k0smotroncluster_service_annotations.go and
        // the Service builder's GetServiceAnnotations(kmc.Annotations)). The
        // spec field below is kept for forward-compat, but without this
        // annotation the LB Service renders with NO annotations — e.g. an AWS
        // NLB silently defaults to scheme "internal".
        ...(this.config.controlPlaneServiceAnnotations
          ? {
              annotations: {
                "k0smotron.io/conversion-dropped-service.annotations":
                  JSON.stringify(this.config.controlPlaneServiceAnnotations),
              },
            }
          : {}),
      },
      spec: {
        version: k0sControlPlaneVersion,
        k0SConfig: {
          apiVersion: "k0s.k0sproject.io/v1beta1",
          kind: "ClusterConfig",
          spec: {
            network: {
              provider: "custom", // CNI installed separately (Calico)
              podCIDR: podCidr,
              serviceCIDR: serviceCidr,
            },
          },
        },
        persistence,
        service: {
          type:
            this.config.controlPlaneServiceType ??
            K0SmotronControlPlaneSpecServiceType.LOAD_BALANCER,
          ...(this.config.controlPlaneServiceAnnotations
            ? { annotations: this.config.controlPlaneServiceAnnotations }
            : {}),
        },
      },
    });

    // 4-6. Worker pools — per pool: AWSMachineTemplate (CAPA places nodes in
    //    the subnets it created; no subnet/SG filters needed since CAPA owns
    //    networking) + K0sWorkerConfigTemplate (cloud-init for storage deps
    //    (Piraeus/LINSTOR) + k0s registration args) + MachineDeployment
    //    (static replicas — no autoscaler).
    const emitWorkerPool = (opts: {
      /** cdk8s construct-id suffix ("" for the default pool) */
      idSuffix: string;
      machineTemplateName: string;
      workerConfigName: string;
      machineDeploymentName: string;
      pool: AwsWorkloadClusterWorkers;
    }) => {
      const pool = opts.pool;
      emitAwsMachineTemplate(this, `worker-template${opts.idSuffix}`, {
        name: opts.machineTemplateName,
        namespace,
        instanceType: pool.instanceType ?? "m6i.large",
        iamInstanceProfile,
        publicIp: pool.publicIp ?? false,
        sshKeyName: this.config.sshKeyName,
        rootVolumeSizeGiB: pool.rootVolumeSizeGiB ?? 80,
        rootVolumeType: pool.rootVolumeType ?? "gp3",
        ami: pool.ami,
        spot: pool.spot,
      });

      // k0s registration args: labels/taints go through the NATIVE `k0s worker`
      // --labels/--taints flags (both take comma-separated lists; taints use the
      // standard key=value:Effect form) — no kubelet-extra-args indirection.
      const k0sWorkerArgs: string[] = [];
      if (pool.nodeLabels && Object.keys(pool.nodeLabels).length > 0) {
        k0sWorkerArgs.push(
          `--labels=${Object.entries(pool.nodeLabels)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")}`,
        );
      }
      if (pool.taints?.length) {
        k0sWorkerArgs.push(
          `--taints=${pool.taints
            .map(
              (t) =>
                `${t.key}${t.value !== undefined ? `=${t.value}` : ""}:${t.effect}`,
            )
            .join(",")}`,
        );
      }
      k0sWorkerArgs.push(...(pool.k0sArgs ?? []));

      // v1beta2 REQUIRED: k0smotron's v1beta2 storage schema renamed
      // preStartCommands -> preK0sCommands and declares no conversion for the
      // old field — applying the v1beta1 shape fails server-side apply with
      // '.spec.template.spec.preStartCommands: field not declared in schema'
      // (live-observed: all worker bootstrap templates rejected, workers never
      // provisioned).
      new K0sWorkerConfigTemplateV1Beta2(this, `worker-config${opts.idSuffix}`, {
        metadata: { name: opts.workerConfigName, namespace },
        spec: {
          template: {
            spec: {
              version: k0sWorkerVersion,
              ...(k0sWorkerArgs.length ? { args: k0sWorkerArgs } : {}),
              preK0SCommands: [
                ...DEFAULT_PRESTART_COMMANDS,
                ...(pool.extraPreStartCommands ?? []),
              ],
            },
          },
        },
      });

      new MachineDeploymentV1Beta1(this, `worker-md${opts.idSuffix}`, {
        metadata: { name: opts.machineDeploymentName, namespace },
        spec: {
          clusterName,
          replicas: pool.replicas ?? 2,
          selector: {
            matchLabels: { "cluster.x-k8s.io/cluster-name": clusterName },
          },
          template: {
            spec: {
              clusterName,
              version: k8sVersion,
              ...(pool.failureDomain
                ? { failureDomain: pool.failureDomain }
                : {}),
              bootstrap: {
                configRef: {
                  apiVersion: "bootstrap.cluster.x-k8s.io/v1beta2",
                  kind: "K0sWorkerConfigTemplate",
                  name: opts.workerConfigName,
                },
              },
              infrastructureRef: {
                apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
                kind: "AWSMachineTemplate",
                name: opts.machineTemplateName,
              },
            },
          },
        },
      });
    };

    // Default pool (the legacy `workers` block). Fixed resource names — NOT
    // hash-rotated — so pre-existing clusters keep their objects untouched.
    // Skipped only when `workerPools` is given without `workers` (pools-only).
    if (this.config.workers || !this.config.workerPools) {
      emitWorkerPool({
        idSuffix: "",
        machineTemplateName,
        workerConfigName,
        machineDeploymentName: `${name}-workers`,
        pool: workers,
      });
    }

    // Named pools. The AWSMachineTemplate spec is IMMUTABLE (CAPA's admission
    // webhook rejects in-place edits), so — like the AwsK0sCluster control
    // plane — the template name embeds a hash of its spec: any change yields a
    // new template and the MachineDeployment's infrastructureRef repoints to
    // it, rolling the pool (the standard CAPI rotate-on-change pattern).
    for (const [poolName, pool] of Object.entries(
      this.config.workerPools ?? {},
    )) {
      const poolTemplateSpec = {
        instanceType: pool.instanceType ?? "m6i.large",
        iamInstanceProfile,
        sshKeyName: this.config.sshKeyName ?? null,
        publicIp: pool.publicIp ?? false,
        rootVolumeSizeGiB: pool.rootVolumeSizeGiB ?? 80,
        rootVolumeType: pool.rootVolumeType ?? "gp3",
        ami: pool.ami ?? null,
        spot: pool.spot ?? false,
      };
      const poolTemplateHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(poolTemplateSpec))
        .digest("hex")
        .slice(0, 8);
      emitWorkerPool({
        idSuffix: `-${poolName}`,
        machineTemplateName: `${name}-${poolName}-${poolTemplateHash}`,
        workerConfigName: `${name}-${poolName}-config`,
        machineDeploymentName: `${name}-${poolName}`,
        pool,
      });
    }
  }
}
