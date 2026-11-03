import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { DualStackSubnet } from "./dualstack-subnet";
import { CILIUM_WIREGUARD_PORT } from "../../k8s/cilium";
import { workerIngressRules, type AwsWorkerFleetIngressRule as AwsWorkerIngressRule } from "./worker-ingress";
import { Vpc, InternetGateway, RouteTable, Route, RouteTableAssociation, SecurityGroup, SecurityGroupRule } from "#imports/ec2.aws.upbound.io";

export type { AwsWorkerIngressRule };

export interface AwsCiliumIngressPeer {
  namePrefix: string;
  ipv4Cidr: string;
  ipv6Cidr: string;
  ipv4NameSuffix?: string;
  ipv6NameSuffix?: string;
}

export interface AwsCiliumIngressConfig {
  peers: AwsCiliumIngressPeer[];
  mesh: { namePrefix: string; securityGroupName: string; descriptionPrefix?: string };
}

/** Dual-stack Cilium transport, health and kubelet access from named peers. */
export function awsCiliumIngressRules(config: AwsCiliumIngressConfig): AwsWorkerIngressRule[] {
  const ports = [
    { protocol: "tcp", ipv6Protocol: "tcp", port: 10250, description: "kubelet (TLS, authn/authz)" },
    { protocol: "udp", ipv6Protocol: "udp", port: CILIUM_WIREGUARD_PORT, description: "cilium WireGuard (Noise-authenticated)" },
    { protocol: "tcp", ipv6Protocol: "tcp", port: 4240, description: "cilium-health node probe" },
    { protocol: "icmp", ipv6Protocol: "58", port: -1, description: "cilium-health ICMP probe" },
  ];
  const peerRules = config.peers.flatMap(peer => ports.flatMap(({ protocol, ipv6Protocol, port, description }) => {
    const ipv4Name = `${peer.namePrefix}-${protocol}-${port}${peer.ipv4NameSuffix ?? ""}`;
    const ipv6Name = `${peer.namePrefix}-${ipv6Protocol}-${port}${peer.ipv6NameSuffix ?? "-v6"}`;
    return [
      { name: ipv4Name, ipProtocol: protocol, fromPort: port, description,
        source: { ipv4Cidr: peer.ipv4Cidr }, tags: { Name: ipv4Name } },
      { name: ipv6Name, ipProtocol: ipv6Protocol, fromPort: port, description,
        source: { ipv6Cidr: peer.ipv6Cidr }, tags: { Name: ipv6Name } },
    ];
  }));
  const meshRules = [
    { name: "wireguard", protocol: "udp", port: CILIUM_WIREGUARD_PORT },
    { name: "health", protocol: "tcp", port: 4240 },
    { name: "icmp", protocol: "icmp", port: -1 },
    { name: "icmp6", protocol: "58", port: -1 },
  ].map(({ name, protocol, port }) => ({
    name: `${config.mesh.namePrefix}-${name}`, ipProtocol: protocol, fromPort: port,
    description: `${config.mesh.descriptionPrefix ?? config.mesh.namePrefix} ${name}`,
    source: { securityGroupName: config.mesh.securityGroupName },
  }));
  return [...peerRules, ...meshRules];
}

export type AwsWorkerNetworkCni = "calico" | "cilium";
export interface AwsWorkerNetworkPort {
  port: number;
  protocol: string;
  description: string;
  /** Emit only the ::/0 rule — for listeners that bind a single family, such
   *  as Calico's separate v6 WireGuard socket. */
  v6Only?: boolean;
  /** Protocol for the ::/0 rule when it differs from the v4 one. ICMPv6 is
   *  AWS protocol 58, NOT a v6 flavour of "icmp" (1) — an icmp rule does not
   *  cover it, and the result is exactly half a working probe. */
  protocolV6?: string;
}

export interface AwsWorkerNetworkRegion {
  /** Short geo tag, e.g. "eu" — used in resource names and node labels. */
  geo: string;
  region: string;
  az: string;
  vpcCidr: string;
  subnetCidr: string;
  /** Extra publicly open ports (e.g. P2P ports on nodes that need them). */
  extraOpenPorts?: AwsWorkerNetworkPort[];
  /** Complete native ingress policy. When supplied (including []), replaces
   * automatic public/CNI ports. Include the CNI mesh ports explicitly. Omit to
   * preserve legacy defaults. Stable rule names support staged adoption. */
  ingressRules?: AwsWorkerIngressRule[];
}

const DEFAULT_OPEN_PORTS: AwsWorkerNetworkPort[] = [
  { port: 10250, protocol: "tcp", description: "kubelet (TLS, authn/authz)" },
  { port: 22, protocol: "tcp", description: "sshd (key-only; RemoteMachine provisioning)" },
];

/**
 * The mesh transport, appended to `openPorts` rather than part of it — a
 * caller overriding the node ports must not be able to close the CNI's own
 * tunnel out from under itself.
 *
 * Getting this wrong is SILENT: the WireGuard interface comes up, peers are
 * configured, and every handshake is dropped with nothing in any log. Cilium
 * listens on one port for both families; Calico runs a separate v6 socket.
 */
const CNI_MESH_PORTS: Record<AwsWorkerNetworkCni, AwsWorkerNetworkPort[]> = {
  calico: [
    { port: 51820, protocol: "udp", description: "calico WireGuard (Noise-authenticated)" },
    {
      port: 51821,
      protocol: "udp",
      description: "calico WireGuard v6 (Noise-authenticated)",
      v6Only: true,
    },
  ],
  cilium: [
    {
      port: CILIUM_WIREGUARD_PORT,
      protocol: "udp",
      description: "cilium WireGuard (Noise-authenticated)",
    },
    // cilium-health's node probe. Unauthenticated, unlike everything else in
    // the default set — but it serves exactly one path, /hello, with a
    // zero-byte body (verified live; /v1beta/status and everything else 404).
    // The one bit it leaks, "this host runs Cilium", is already implied by the
    // WireGuard port beside it. On a mesh whose peers are cross-region over
    // the public internet the alternative is no health signal at all, and this
    // is the fleet where a silently half-dead mesh is the failure that hurts.
    {
      port: 4240,
      protocol: "tcp",
      description: "cilium-health node probe",
    },
    {
      port: -1,
      protocol: "icmp",
      protocolV6: "58",
      description: "cilium-health ICMP probe",
    },
  ],
};


export interface AwsWorkerNetworkConfig extends AwsWorkerNetworkRegion {
  namePrefix: string;
  clusterName: string;
  providerConfigName?: string;
  openPorts?: AwsWorkerNetworkPort[];
  cni?: AwsWorkerNetworkCni;
}

/** Public dual-stack worker network, independently of the machine lifecycle. */
export class AwsWorkerNetwork extends Construct {
  constructor(parent: Construct, id: string, config: AwsWorkerNetworkConfig) {
    super(parent, id);
    const scope = this;
    const cfg = config;
    const pcRef = { name: config.providerConfigName ?? "default" };
    const p = `${config.namePrefix}-${cfg.geo}`;
    new Vpc(scope, `${p}-vpc`, {
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
        providerConfigRef: pcRef,
      },
    });
    new DualStackSubnet(scope, `${p}-subnet`, {
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
        [`kubernetes.io/cluster/${config.clusterName}`]: "shared",
      },
    });
    new InternetGateway(scope, `${p}-igw`, {
      metadata: { name: `${p}-igw` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          tags: { Name: `${p}-igw` },
        },
        providerConfigRef: pcRef,
      },
    });
    new RouteTable(scope, `${p}-rt`, {
      metadata: { name: `${p}-rt` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          tags: { Name: `${p}-rt` },
        },
        providerConfigRef: pcRef,
      },
    });
    new Route(scope, `${p}-default-route`, {
      metadata: { name: `${p}-default-route` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          destinationCidrBlock: "0.0.0.0/0",
          gatewayIdRef: { name: `${p}-igw` },
        },
        providerConfigRef: pcRef,
      },
    });
    new Route(scope, `${p}-default-route-v6`, {
      metadata: { name: `${p}-default-route-v6` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          destinationIpv6CidrBlock: "::/0",
          gatewayIdRef: { name: `${p}-igw` },
        },
        providerConfigRef: pcRef,
      },
    });
    new RouteTableAssociation(scope, `${p}-rta`, {
      metadata: { name: `${p}-rta` },
      spec: {
        forProvider: {
          region: cfg.region,
          routeTableIdRef: { name: `${p}-rt` },
          subnetIdRef: { name: `${p}-subnet` },
        },
        providerConfigRef: pcRef,
      },
    });
    new SecurityGroup(scope, `${p}-sg`, {
      metadata: { name: `${p}-sg` },
      spec: {
        forProvider: {
          region: cfg.region,
          vpcIdRef: { name: `${p}-vpc` },
          name: `${p}-node`,
          description: `${config.namePrefix} worker node (mesh-only ingress)`,
          tags: { Name: `${p}-node` },
        },
        providerConfigRef: pcRef,
      },
    });
    const rules = [
      ...(config.openPorts ?? DEFAULT_OPEN_PORTS),
      ...(cfg.extraOpenPorts ?? []),
      ...CNI_MESH_PORTS[config.cni ?? "calico"],
    ];
    if (cfg.ingressRules !== undefined) {
      workerIngressRules(scope, cfg.ingressRules, cfg.region, `${p}-sg`, pcRef.name);
    } else rules.forEach((r) => {
      (
        [
          ["any", { cidrIpv4: "0.0.0.0/0" }],
          ["any6", { cidrIpv6: "::/0" }],
        ] as const
      ).forEach(([suffix, cidr]) => {
        if (r.v6Only && suffix === "any") return;
        const proto = suffix === "any6" ? (r.protocolV6 ?? r.protocol) : r.protocol;
        const n = `${p}-in-${proto}-${r.port}-${suffix}`;
        new ApiObject(scope, n, {
          apiVersion: "ec2.aws.upbound.io/v1beta1",
          kind: "SecurityGroupIngressRule",
          metadata: { name: n },
          spec: {
            forProvider: {
              region: cfg.region,
              securityGroupIdRef: { name: `${p}-sg` },
              ipProtocol: proto,
              fromPort: r.port,
              toPort: r.port,
              ...cidr,
              description: r.description,
              tags: { Name: n },
            },
            providerConfigRef: pcRef,
          },
        });
      });
    });
    // Egress stays on the legacy resource: a single fixed CIDR that never
    // changes, so it never hits the replacement refusal above, and migrating
    // it would mean revoking all egress before the modern rule authorizes it.
    new SecurityGroupRule(scope, `${p}-egress-all`, {
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
        providerConfigRef: pcRef,
      },
    });
    // v6 egress as its OWN modern rule: the legacy rule cannot gain a family
    // in place (replacement-refused).
    new ApiObject(scope, `${p}-egress-all-v6`, {
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
        providerConfigRef: pcRef,
      },
    });
  }
}
