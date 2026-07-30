/**
 * Worker fleet — the git-side half of the ONE node unit for every cluster
 * node, in every region (pairs with the k0s {@link Worker} composition, which
 * derives the runtime bindings: pooled SSH inventory + instance-id-named
 * EIPAssociation/VolumeAttachment followers).
 *
 * A node is NOT a CAPI machine: each is a 1:1 Crossplane resource group
 * (Instance + Eip + optional data EBSVolume) adopted as a CAPI Machine via
 * k0smotron's RemoteMachine provider. No token, no address and no k0s install
 * logic lives in git: userData is only host identity + storage + the
 * provisioner's SSH key.
 *
 * Regions are public-subnet + IGW only (nodes carry EIPs for the SSH
 * entrance; egress goes straight out — no NAT gateways). Subnets are the
 * composed dual-stack kind: the v6 /64 derives from the Vpc's OBSERVED
 * Amazon-provided GUA assignment (runtime state, never in git). Node identity
 * is v6-primary: kubelet gets --node-ip=<GUA>,<private-v4>, so cross-region
 * traffic rides WireGuard-v6 between on-link GUAs while v4 stays plain
 * intra-VPC private addressing.
 *
 * Storage: one gp3 EBS volume per data-bearing node, consumed as an LVM VG
 * for OpenEBS LocalPV-LVM. Growth is git-driven: bump the EBSVolume size, the
 * on-node pvresize timer picks up the physical growth, then bump the PVC.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { Worker } from "../k0s/worker";
import { DualStackSubnet } from "./dualstack-subnet";
import { resolveSecrets } from "../../../utils/secrets";
import {
  Eip,
  EipSpecManagementPolicies,
  InternetGateway,
  Route,
  RouteTable,
  RouteTableAssociation,
  SecurityGroup,
  SecurityGroupRule,
  Vpc,
} from "#imports/ec2.aws.upbound.io";
import {
  InstanceProfile,
  Role,
  RolePolicyAttachment,
} from "#imports/iam.aws.upbound.io";

export interface AwsWorkerFleetPort {
  port: number;
  protocol: string;
  description: string;
}

export interface AwsWorkerFleetOptions {
  /** Resource-name prefix, e.g. "stage" — regions become `<prefix>-<geo>-…`. */
  namePrefix: string;
  /** CAPI cluster name (Machine.clusterName + cluster label + elb tag). */
  clusterName: string;
  /** k0s version for K0sWorkerConfig/Machine, e.g. "v1.33.12+k0s.0". */
  k0sVersion: string;
  /** Provisioner keypair: PUBLIC half (safe in git) lands in authorized_keys;
   *  the private half is sops-only and becomes the Secret in addSshSecret(). */
  sshPublicKey: string;
  /** Secret holding the SSH private key under key "value". */
  sshSecretName: string;
  /** LVM VG name on data-bearing nodes (OpenEBS LocalPV-LVM). */
  dataVgName: string;
  /** Organization tag/label domain, e.g. "nuconstruct.io" — used for the
   *  purpose/geo/node tags and the spot Machine label. */
  tagDomain: string;
  /** Purpose tag value for fleet EIPs and instances, e.g. "stage-worker". */
  eipPurpose: string;
  /** v6 ClusterIP of the CoreDNS v6 face (kubelet --cluster-dns). Omit to
   *  keep the k0s default (v4 kube-dns) — cross-region pods then depend on
   *  cross-region v4 pod routing, which private node identity does not have. */
  clusterDns?: string;
  /** Namespace for the adoption objects (default "default"). */
  namespace?: string;
  /** Crossplane ProviderConfig (default "default"). */
  providerConfigName?: string;
  /**
   * Publicly open node ports, BOTH families. Default is the authenticated
   * trio — WireGuard 51820 (Noise), kubelet 10250 (TLS + authn/authz, needed
   * by metrics-server which dials InternalIP from arbitrary egress addresses),
   * sshd 22 (key-only; the k0smotron provisioner dials in from pods whose
   * egress addresses are not stable). The posture in one line:
   * cryptographically authenticated protocols are open and take no source
   * list; unauthenticated ones are not exposed at all. No VXLAN (4789):
   * WireGuard carries all cross-node pod traffic, and an open VXLAN lets
   * Calico silently fall back to CLEARTEXT over the internet for any peer
   * whose WireGuard is broken. No plaintext exporters (9100/10249): scraped
   * over the WireGuard mesh instead.
   */
  openPorts?: AwsWorkerFleetPort[];
}

export interface AwsWorkerFleetRegion {
  /** Short geo tag, e.g. "eu" — used in resource names and node labels. */
  geo: string;
  region: string;
  az: string;
  vpcCidr: string;
  subnetCidr: string;
  /** Extra publicly open ports (e.g. chain P2P where tool-nodes live). */
  extraOpenPorts?: AwsWorkerFleetPort[];
}

export interface AwsWorkerFleetNode {
  /** Node name — hostname AND k8s node name AND MR name. */
  name: string;
  ami: string;
  instanceType: string;
  /** kubelet --node-labels (geo/topology labels are added from the region). */
  nodeLabels: Record<string, string>;
  /** Raw --register-with-taints entries, e.g. "workload=x:NoSchedule". */
  taints?: string[];
  /** Data volume size in GiB (the LVM PV under OpenEBS). Omit: no volume. */
  dataVolumeGi?: number;
  /** Override the data-volume MR name (an MR rename is a volume REPLACEMENT —
   *  days of chain resync). Defaults to `<name>-data`. */
  dataVolumeMrName?: string;
  rootVolumeGi?: number;
  spot?: boolean;
  /** IMDS hop limit 2: pods on this node may use the node role (keyless AWS
   *  controllers). System nodes only. */
  imdsPodAccess?: boolean;
  /** Existing named Eip MR to associate (e.g. a P2P identity). Default: an
   *  Eip named after the node (allocate with fleet.addEip()). */
  eipName?: string;
  /** Instance profile override (e.g. the controller-policy profile on system
   *  nodes; everything else gets the fleet's SSM-only role). */
  iamProfile?: string;
}

const DEFAULT_OPEN_PORTS: AwsWorkerFleetPort[] = [
  { port: 51820, protocol: "udp", description: "calico WireGuard (Noise-authenticated)" },
  { port: 10250, protocol: "tcp", description: "kubelet (TLS, authn/authz)" },
  { port: 22, protocol: "tcp", description: "sshd (key-only; RemoteMachine provisioning)" },
];

/**
 * The fleet: shared options + emitters for IAM, EIPs, region networks and
 * nodes. Emits nothing by itself — call the methods from the cluster app.
 */
export class AwsWorkerFleet extends Construct {
  constructor(
    scope: Construct,
    id: string,
    private readonly options: AwsWorkerFleetOptions,
  ) {
    super(scope, id);
  }

  private get ns() {
    return this.options.namespace ?? "default";
  }

  private get pcRef() {
    return { name: this.options.providerConfigName ?? "default" };
  }

  private prefix(region: AwsWorkerFleetRegion) {
    return `${this.options.namePrefix}-${region.geo}`;
  }

  /**
   * Allocate a node's stable EIP. Standalone so addresses exist ahead of the
   * instances. OBSERVE/CREATE/DELETE only: the association is owned by the
   * Worker composition, and Update/LateInitialize on the Eip itself would
   * fight it — full management sees the runtime association as drift and
   * DisassociateAddresses on every reconcile, while LateInitialize captures a
   * then-current instance id that goes stale on replacement.
   */
  addEip(name: string, region: string) {
    new Eip(this, `${name}-eip`, {
      metadata: { name },
      spec: {
        managementPolicies: [
          EipSpecManagementPolicies.OBSERVE,
          EipSpecManagementPolicies.CREATE,
          EipSpecManagementPolicies.DELETE,
        ],
        forProvider: {
          region,
          domain: "vpc",
          tags: {
            Name: name,
            [`${this.options.tagDomain}/purpose`]: this.options.eipPurpose,
          },
        },
        providerConfigRef: this.pcRef,
      },
    });
  }

  /** IAM for non-system nodes: SSM-only (debug access — no SSH anywhere). */
  addIam(): string {
    const roleName = `${this.options.namePrefix}-worker-node`;
    new Role(this, "worker-node-role", {
      metadata: { name: roleName },
      spec: {
        forProvider: {
          assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
        },
        providerConfigRef: this.pcRef,
      },
    });
    new RolePolicyAttachment(this, "worker-node-ssm", {
      metadata: { name: `${roleName}-ssm` },
      spec: {
        forProvider: {
          policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
          roleRef: { name: roleName },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new InstanceProfile(this, "worker-node-profile", {
      metadata: { name: roleName },
      spec: {
        forProvider: { roleRef: { name: roleName } },
        providerConfigRef: this.pcRef,
      },
    });
    return roleName;
  }

  /** The provisioner's SSH private key as the Secret the Worker composition
   *  references (k0smotron requires the key under "value"). */
  addSshSecret(privateKeyRef: string) {
    new ApiObject(this, "worker-ssh-secret", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: this.options.sshSecretName, namespace: this.ns },
      stringData: { value: resolveSecrets(privateKeyRef) },
    });
  }

  /**
   * Per-region network: public dual-stack subnet + IGW only. Ingress rules
   * are SecurityGroupIngressRule (one CIDR each), NOT the legacy
   * SecurityGroupRule: a cidr_blocks LIST change is replacement-requiring and
   * the upjet provider refuses replacement, so every source-list edit wedges
   * the MR permanently. Every public port opens for BOTH families (an SG cidr
   * never implies the other family — found live as 100% WG-v6 loss with
   * perfect peers); 51821 is Felix's v6-only WireGuard port.
   */
  addRegion(cfg: AwsWorkerFleetRegion): string {
    const p = this.prefix(cfg);
    new Vpc(this, `${p}-vpc`, {
      metadata: { name: `${p}-vpc` },
      spec: {
        forProvider: {
          region: cfg.region,
          cidrBlock: cfg.vpcCidr,
          assignGeneratedIpv6CidrBlock: true,
          enableDnsSupport: true,
          enableDnsHostnames: true,
          tags: { Name: `${p}-vpc` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new DualStackSubnet(this, `${p}-subnet`, {
      vpcMrName: `${p}-vpc`,
      region: cfg.region,
      availabilityZone: cfg.az,
      cidrBlock: cfg.subnetCidr,
      mapPublicIpOnLaunch: true,
      // AWS LB controller subnet discovery: role/elb marks the public subnet
      // eligible for internet-facing LBs.
      tags: {
        Name: `${p}-subnet`,
        "kubernetes.io/role/elb": "1",
        [`kubernetes.io/cluster/${this.options.clusterName}`]: "shared",
      },
    });
    new InternetGateway(this, `${p}-igw`, {
      metadata: { name: `${p}-igw` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          tags: { Name: `${p}-igw` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new RouteTable(this, `${p}-rt`, {
      metadata: { name: `${p}-rt` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          tags: { Name: `${p}-rt` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new Route(this, `${p}-default-route`, {
      metadata: { name: `${p}-default-route` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          destinationCidrBlock: "0.0.0.0/0",
          gatewayIdRef: { name: `${p}-igw` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new Route(this, `${p}-default-route-v6`, {
      metadata: { name: `${p}-default-route-v6` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          destinationIpv6CidrBlock: "::/0",
          gatewayIdRef: { name: `${p}-igw` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new RouteTableAssociation(this, `${p}-rta`, {
      metadata: { name: `${p}-rta` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          subnetIdRef: { name: `${p}-subnet` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    new SecurityGroup(this, `${p}-sg`, {
      metadata: { name: `${p}-sg` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          name: `${p}-node`,
          description: `${this.options.namePrefix} worker node (mesh-only ingress)`,
          tags: { Name: `${p}-node` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    const rules = [
      ...(this.options.openPorts ?? DEFAULT_OPEN_PORTS),
      ...(cfg.extraOpenPorts ?? []),
      { port: 51821, protocol: "udp", description: "calico WireGuard v6 (Noise-authenticated)" },
    ];
    rules.forEach((r) => {
      (
        [
          ["any", { cidrIpv4: "0.0.0.0/0" }],
          ["any6", { cidrIpv6: "::/0" }],
        ] as const
      ).forEach(([suffix, cidr]) => {
        if (r.port === 51821 && suffix === "any") return;
        const n = `${p}-in-${r.protocol}-${r.port}-${suffix}`;
        new ApiObject(this, n, {
          apiVersion: "ec2.aws.upbound.io/v1beta1",
          kind: "SecurityGroupIngressRule",
          metadata: { name: n },
          spec: {
            forProvider: {
              region: cfg.region,
              securityGroupIdRef: { name: `${p}-sg` },
              ipProtocol: r.protocol,
              fromPort: r.port,
              toPort: r.port,
              ...cidr,
              description: r.description,
              tags: { Name: n },
            },
            providerConfigRef: this.pcRef,
          },
        });
      });
    });
    // Egress stays on the legacy resource: a single fixed CIDR that never
    // changes, so it never hits the replacement refusal above, and migrating
    // it would mean revoking all egress before the modern rule authorizes it.
    new SecurityGroupRule(this, `${p}-egress-all`, {
      metadata: { name: `${p}-egress-all` },
      spec: {
        forProvider: {
          region: cfg.region,
          securityGroupIdRef: { name: `${p}-sg` },
          type: "egress",
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          description: "all egress (P2P dial-out, CP NLB, apt, images)",
        },
        providerConfigRef: this.pcRef,
      },
    });
    // v6 egress as its OWN modern rule: the legacy rule cannot gain a family
    // in place (replacement-refused).
    new ApiObject(this, `${p}-egress-all-v6`, {
      apiVersion: "ec2.aws.upbound.io/v1beta1",
      kind: "SecurityGroupEgressRule",
      metadata: { name: `${p}-egress-all-v6` },
      spec: {
        forProvider: {
          region: cfg.region,
          securityGroupIdRef: { name: `${p}-sg` },
          ipProtocol: "-1",
          cidrIpv6: "::/0",
          description: "all v6 egress (WG-v6 handshakes, dual-stack dial-out)",
          tags: { Name: `${p}-egress-all-v6` },
        },
        providerConfigRef: this.pcRef,
      },
    });
    return p;
  }

  private userData(node: AwsWorkerFleetNode): string {
    const o = this.options;
    // Data volume -> LVM VG. create-if-absent ONLY: on instance replacement
    // the volume re-attaches carrying its data — vgcreate on a populated PV
    // would destroy exactly what this design preserves.
    const lvmSection = node.dataVolumeGi
      ? `
ROOT_PART=$(findmnt -no SOURCE /)
ROOT_DISK=/dev/$(lsblk -no PKNAME "$ROOT_PART")
DEV=""
for i in $(seq 1 90); do
  DEV=$(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}' | grep -vx "$ROOT_DISK" | head -1)
  [ -n "$DEV" ] && break
  sleep 10
done
if [ -n "$DEV" ]; then
  vgs ${o.dataVgName} >/dev/null 2>&1 || { pvcreate -y "$DEV" && vgcreate ${o.dataVgName} "$DEV"; }
fi

# Hands-off physical growth: EBSVolume size bumps in git are picked up by an
# idempotent pvresize timer (no-op when nothing changed).
cat > /usr/local/bin/pvresize-all <<'PVEOF'
#!/bin/sh
for pv in $(pvs --noheadings -o pv_name); do pvresize "$pv"; done
PVEOF
chmod +x /usr/local/bin/pvresize-all
cat > /etc/systemd/system/pvresize.service <<'PVEOF'
[Unit]
Description=pvresize all PVs (pick up grown EBS volumes)
[Service]
Type=oneshot
ExecStart=/usr/local/bin/pvresize-all
PVEOF
cat > /etc/systemd/system/pvresize.timer <<'PVEOF'
[Unit]
Description=periodic pvresize
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
[Install]
WantedBy=timers.target
PVEOF
systemctl daemon-reload
systemctl enable --now pvresize.timer
`
      : "";
    return `#!/bin/bash
set -x
exec >> /var/log/${o.namePrefix}-worker-init.log 2>&1
export DEBIAN_FRONTEND=noninteractive
hostnamectl set-hostname ${node.name}

# Provisioner access FIRST — before apt and before the up-to-15-minute
# data-volume wait (observed live: auth failures throughout the disk-wait
# window when this was written last).
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
cat >> /home/ubuntu/.ssh/authorized_keys <<'KEYEOF'
${o.sshPublicKey}
KEYEOF
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 30 ] && return 1; sleep 10; done; }
retry apt-get update -qq
retry apt-get install -y -qq lvm2 curl
${lvmSection}`;
  }

  /** One node: Instance (+ optional data EBSVolume) + adoption plumbing.
   *  The EIPAssociation and VolumeAttachment followers are composed by the
   *  Worker XR with instance-id-derived names — never declared here. */
  addNode(region: AwsWorkerFleetRegion, node: AwsWorkerFleetNode, iamProfile: string) {
    const o = this.options;
    const p = this.prefix(region);
    const dataVolumeMrName = node.dataVolumeGi
      ? (node.dataVolumeMrName ?? `${node.name}-data`)
      : undefined;
    if (dataVolumeMrName) {
      new ApiObject(this, `${node.name}-data-volume`, {
        apiVersion: "ec2.aws.upbound.io/v1beta1",
        kind: "EBSVolume",
        metadata: { name: dataVolumeMrName },
        spec: {
          deletionPolicy: "Delete",
          forProvider: {
            region: region.region,
            availabilityZone: region.az,
            size: node.dataVolumeGi,
            type: "gp3",
            encrypted: true,
            tags: {
              Name: `${node.name}-data`,
              [`${o.tagDomain}/node`]: node.name,
            },
          },
          providerConfigRef: this.pcRef,
        },
      });
    }
    new ApiObject(this, `${node.name}-instance`, {
      apiVersion: "ec2.aws.upbound.io/v1beta2",
      kind: "Instance",
      metadata: { name: node.name },
      spec: {
        deletionPolicy: "Delete",
        // No LateInitialize: it captured the first instance's ENI into spec,
        // and after a replacement the provider refuses the resulting "update"
        // forever — wedging reconciliation while the node runs fine.
        managementPolicies: ["Observe", "Create", "Update", "Delete"],
        forProvider: {
          region: region.region,
          ami: node.ami,
          instanceType: node.instanceType,
          // resolve Always: an AZ move replaces the subnet, and a frozen
          // resolved id would wedge instance creation on the dead subnet.
          subnetIdRef: { name: `${p}-subnet`, policy: { resolve: "Always", resolution: "Required" } },
          vpcSecurityGroupIdRefs: [
            { name: `${p}-sg`, policy: { resolve: "Always", resolution: "Required" } },
          ],
          iamInstanceProfile: node.iamProfile ?? iamProfile,
          sourceDestCheck: false,
          associatePublicIpAddress: true,
          ipv6AddressCount: 1,
          ...(node.imdsPodAccess
            ? {
                // Hop limit 2 exposes the node role to pods over IMDS —
                // keyless AWS controllers. System nodes ONLY.
                metadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 2 },
              }
            : {}),
          rootBlockDevice: {
            volumeSize: node.rootVolumeGi ?? 100,
            volumeType: "gp3",
            encrypted: true,
          },
          ...(node.spot ? { instanceMarketOptions: { marketType: "spot" } } : {}),
          userData: this.userData(node),
          userDataReplaceOnChange: true,
          tags: {
            Name: node.name,
            [`${o.tagDomain}/geo`]: region.geo,
            [`${o.tagDomain}/purpose`]: o.eipPurpose,
          },
        },
        providerConfigRef: this.pcRef,
      },
    });

    // --- CAPI adoption -----------------------------------------------------
    // Worker (nebula) observes this node's Eip + Instance and publishes a
    // PooledRemoteMachine into a POOL OF ONE plus the follower MRs. The three
    // objects below are fully static; k0smotron fills the RemoteMachine's
    // connection details from the pool at reservation, and CAPI adopts the
    // RemoteMachine + K0sWorkerConfig (which is why the composition cannot
    // own them: adoption and composition both demand the controller
    // ownerReference).
    new Worker(this, node.name, {
      eipName: node.eipName ?? node.name,
      instanceName: node.name,
      region: region.region,
      dataVolumeName: dataVolumeMrName,
      sshSecretName: o.sshSecretName,
    });
    new ApiObject(this, `${node.name}-remote-machine`, {
      apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
      kind: "RemoteMachine",
      metadata: { name: node.name, namespace: this.ns },
      spec: { pool: node.name },
    });
    const labels = {
      ...node.nodeLabels,
      [`${o.tagDomain}/geo`]: region.geo,
      "topology.kubernetes.io/region": region.region,
      "topology.kubernetes.io/zone": region.az,
    };
    const labelArg = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const taintArg = node.taints?.length
      ? ` --register-with-taints=${node.taints.join(",")}`
      : "";
    const dnsArg = o.clusterDns ? `--cluster-dns=${o.clusterDns} ` : "";
    new ApiObject(this, `${node.name}-worker-config`, {
      apiVersion: "bootstrap.cluster.x-k8s.io/v1beta2",
      kind: "K0sWorkerConfig",
      metadata: { name: node.name, namespace: this.ns },
      spec: {
        version: o.k0sVersion,
        // hostnamectl in userData already set the node name; without this
        // the bootstrap provider would override the hostname with the
        // Machine name.
        useSystemHostname: true,
        // The node's own addresses, read at provision time: the on-link GUA
        // (primary — cross-region identity, WG-v6) and the plain private v4
        // (intra-VPC only). The EIP is NOT an identity: it remains only the
        // SSH provisioning entrance and, where named, the P2P endpoint. The
        // GUA is delivered by RA/DHCPv6 — bounded wait, then record it.
        preK0sCommands: [
          `sh -c 'TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300"); curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4 > /run/node-ip'`,
          `sh -c 'IFACE=$(ip route show default | awk "{print \\$5}" | head -1); for i in $(seq 1 30); do IP6=$(ip -6 addr show dev "$IFACE" scope global 2>/dev/null | awk "/inet6/{print \\$2; exit}" | cut -d/ -f1); [ -n "$IP6" ] && break; sleep 2; done; echo "$IP6" > /run/node-ip6'`,
        ],
        // Commands are executed through the node's shell (SSH exec), so the
        // $(cat ...) substitutes there — the address never appears in git.
        args: [
          `--kubelet-extra-args="--node-ip=$(cat /run/node-ip6),$(cat /run/node-ip) ${dnsArg}--node-labels=${labelArg}${taintArg}"`,
        ],
      },
    });
    new ApiObject(this, `${node.name}-machine`, {
      apiVersion: "cluster.x-k8s.io/v1beta2",
      kind: "Machine",
      metadata: {
        name: node.name,
        namespace: this.ns,
        labels: {
          "cluster.x-k8s.io/cluster-name": o.clusterName,
          ...(node.spot ? { [`${o.tagDomain}/spot`]: "true" } : {}),
        },
      },
      spec: {
        clusterName: o.clusterName,
        version: o.k0sVersion.split("+")[0],
        bootstrap: {
          configRef: {
            apiGroup: "bootstrap.cluster.x-k8s.io",
            kind: "K0sWorkerConfig",
            name: node.name,
          },
        },
        infrastructureRef: {
          apiGroup: "infrastructure.cluster.x-k8s.io",
          kind: "RemoteMachine",
          name: node.name,
        },
      },
    });
  }
}
