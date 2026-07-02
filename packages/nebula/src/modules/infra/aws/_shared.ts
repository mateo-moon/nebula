import { Construct } from "constructs";
import { JsonPatch } from "cdk8s";
import { ClusterV1Beta2 } from "#imports/cluster.x-k8s.io";
import {
  AwsClusterV1Beta2,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
  AwsClusterV1Beta2SpecNetworkAdditionalControlPlaneIngressRulesProtocol as IngressProtocol,
  AwsClusterV1Beta2SpecNetworkAdditionalNodeIngressRulesProtocol as NodeIngressProtocol,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerAdditionalListenersProtocol as LbListenerProtocol,
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerIngressRulesProtocol as LbIngressProtocol,
  AwsClusterV1Beta2SpecNetworkVpcAvailabilityZoneSelection as AzSelection,
  AwsMachineTemplateV1Beta2,
  AwsMachineTemplateV1Beta2SpecTemplateSpecInstanceMetadataOptionsHttpEndpoint as ImdsHttpEndpoint,
  AwsMachineTemplateV1Beta2SpecTemplateSpecInstanceMetadataOptionsHttpTokens as ImdsHttpTokens,
} from "#imports/infrastructure.cluster.x-k8s.io";

/**
 * AMI / image-lookup selection shared by the AWS cluster modules.
 *
 * Strongly recommend setting `id` to a region-specific Ubuntu AMI; k0s is
 * installed via cloud-init so a clean Ubuntu image is ideal. If omitted, CAPA's
 * default image lookup is used (may not suit k0s).
 */
export interface AmiSelection {
  id?: string;
  lookupOrg?: string;
  lookupBaseOs?: string;
  lookupFormat?: string;
}

/**
 * EC2 Spot selection shared by the AWS cluster modules.
 *
 * `true` (or `{}`) requests Spot capacity with the bid capped at the on-demand
 * price (CAPA emits an empty `spotMarketOptions`); `{ maxPrice: "0.20" }` sets
 * an explicit USD/hour cap. Spot instances can be reclaimed with a 2-minute
 * notice, so only use for pools that tolerate node loss.
 */
export type SpotSelection = boolean | { maxPrice?: string };

/**
 * A node security-group ingress rule (friendly shape for module configs; mapped
 * onto CAPA's `network.additionalNodeIngressRules` CRD field, which appends
 * rules to the node security group).
 */
export interface NodeIngressRuleSpec {
  /** AWS SG rule description (NB: '>' is rejected by AWS — no "->" arrows). */
  description: string;
  /** Protocol — the values match CAPA's enum ("-1" = all protocols). */
  protocol: "tcp" | "udp" | "icmp" | "-1";
  fromPort: number;
  toPort: number;
  /** Source CIDR blocks (e.g. ["0.0.0.0/0"] for public P2P ports). */
  cidrBlocks: string[];
}

/**
 * Build the AMI portion of an `AWSMachineTemplate` spec, to be spread into
 * `template.spec`:
 *  - an explicit `ami.id` wins if provided;
 *  - otherwise any `imageLookup*` fields that are set;
 *  - otherwise `{}` (CAPA's default image lookup).
 */
export function buildAmiSpec(ami: AmiSelection = {}): {
  ami?: { id: string };
  imageLookupOrg?: string;
  imageLookupBaseOs?: string;
  imageLookupFormat?: string;
} {
  if (ami.id) {
    return { ami: { id: ami.id } };
  }
  if (ami.lookupOrg || ami.lookupBaseOs || ami.lookupFormat) {
    return {
      ...(ami.lookupOrg ? { imageLookupOrg: ami.lookupOrg } : {}),
      ...(ami.lookupBaseOs ? { imageLookupBaseOs: ami.lookupBaseOs } : {}),
      ...(ami.lookupFormat ? { imageLookupFormat: ami.lookupFormat } : {}),
    };
  }
  return {};
}

/**
 * Build the AWS credentials INI that CAPA consumes (base64-encoded into the
 * `AWS_B64ENCODED_CREDENTIALS` secret key). Shared by the cluster-api-operator
 * module (static keys) and the `nebula bootstrap --provider aws` CLI (static or
 * SSO/session tokens) so the INI format lives in one place.
 */
export function buildCapaCredentialsIni(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}): string {
  return (
    `[default]\n` +
    `aws_access_key_id = ${opts.accessKeyId}\n` +
    `aws_secret_access_key = ${opts.secretAccessKey}\n` +
    (opts.sessionToken ? `aws_session_token = ${opts.sessionToken}\n` : "") +
    `region = ${opts.region}\n`
  );
}

/** Base64-encode the CAPA credentials INI for the `AWS_B64ENCODED_CREDENTIALS` key. */
export function toCapaB64(ini: string): string {
  return Buffer.from(ini, "utf-8").toString("base64");
}

/**
 * Default cloud-init preStartCommands (storage deps for Piraeus/LINSTOR).
 * Shared by the workload-cluster worker config and the standalone
 * control-plane k0s config.
 */
export const DEFAULT_PRESTART_COMMANDS: readonly string[] = [
  "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
  "apt-get update -qq && apt-get install -y -qq linux-headers-$(uname -r) lvm2 thin-provisioning-tools open-iscsi cryptsetup",
  "systemctl enable --now iscsid || true",
];

/**
 * Emit the CAPI `Cluster` CR. Identical across both AWS cluster modules except
 * for the control-plane kind (`K0smotronControlPlane` vs `K0sControlPlane`).
 */
export function emitClusterCr(
  scope: Construct,
  opts: {
    clusterName: string;
    namespace: string;
    podCidr: string;
    serviceCidr: string;
    controlPlaneKind: string;
    controlPlaneName: string;
  },
): ClusterV1Beta2 {
  return new ClusterV1Beta2(scope, "cluster", {
    metadata: { name: opts.clusterName, namespace: opts.namespace },
    spec: {
      clusterNetwork: {
        pods: { cidrBlocks: [opts.podCidr] },
        services: { cidrBlocks: [opts.serviceCidr] },
      },
      // CAPI v1beta2 uses ContractVersionedObjectReference: the ref carries
      // `apiGroup` (NOT a versioned `apiVersion`) — the version is resolved from
      // the referenced CRD's contract labels — and `namespace` is no longer
      // permitted on these refs. Emitting the old apiVersion shape under a
      // v1beta2 Cluster would silently drop the ref (split control plane / infra).
      controlPlaneRef: {
        apiGroup: "controlplane.cluster.x-k8s.io",
        kind: opts.controlPlaneKind,
        name: opts.controlPlaneName,
      },
      infrastructureRef: {
        apiGroup: "infrastructure.cluster.x-k8s.io",
        kind: "AWSCluster",
        name: opts.clusterName,
      },
    },
  });
}

/**
 * Emit the `AWSCluster` CR. CAPA owns the VPC/subnets/SGs; the only per-module
 * difference is the control-plane LoadBalancer type (DISABLED for the
 * k0smotron hosted control plane vs an NLB for the standalone control plane).
 */
export function emitAwsClusterCr(
  scope: Construct,
  opts: {
    clusterName: string;
    namespace: string;
    region: string;
    sshKeyName?: string;
    loadBalancerType: AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType;
    /**
     * NLB scheme. CAPA defaults to internet-facing when this is omitted; set it
     * to INTERNAL to keep the control-plane API off the public internet.
     */
    loadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
    vpcCidr: string;
    /**
     * Cap the number of AZs CAPA spreads subnets across. CAPA creates one NAT
     * gateway (and thus one Elastic IP) per AZ, so on EIP-constrained accounts set
     * this to 1 (single-AZ, 1 NAT/EIP). Omitted = CAPA default (up to 3 AZs).
     */
    availabilityZoneUsageLimit?: number;
    /**
     * Secondary IPv4 CIDR blocks to associate with the managed VPC. CAPA associates
     * these on a LIVE VPC (not only at creation), so it's how you add address space
     * for additional-AZ subnets once the primary cidrBlock is fully tiled. Emitted
     * via JsonPatch — the field postdates the generated cdk8s CRD types.
     */
    secondaryCidrBlocks?: string[];
    /**
     * Explicit subnet set (the FULL list: existing + new). When provided, CAPA adopts
     * existing subnets by AZ+CIDR and CREATES the rest. Required to add AZs to a live
     * cluster — availabilityZoneUsageLimit is honored ONLY at VPC creation, so it is
     * inert on an already-provisioned VPC.
     */
    subnets?: Array<{
      availabilityZone: string;
      cidrBlock: string;
      isPublic: boolean;
      /** Logical id (CAPA convention: `<cluster>-subnet-<public|private>-<az>`). */
      id: string;
    }>;
    /**
     * Extra ingress rules appended to the NODE security group (CAPA
     * `network.additionalNodeIngressRules`). Use for workloads that need
     * public inbound ports on the workers, e.g. Ethereum P2P (30303 + 9000
     * tcp/udp from 0.0.0.0/0). Omitted = the node SG stays CAPA-default
     * (intra-cluster only).
     */
    additionalNodeIngressRules?: NodeIngressRuleSpec[];
  },
): AwsClusterV1Beta2 {
  // SG rules that gate node-to-node + NLB traffic must cover EVERY CIDR a node can
  // get an IP from: the primary VPC CIDR plus any secondary CIDRs (added-AZ subnets
  // are carved from those). Scoping these to just vpcCidr would silently deny the
  // 9443 controller-join + 8132 konnectivity rules to nodes in a secondary-CIDR AZ.
  const nodeCidrs = [opts.vpcCidr, ...(opts.secondaryCidrBlocks ?? [])];

  const cr = new AwsClusterV1Beta2(scope, "aws-cluster", {
    metadata: { name: opts.clusterName, namespace: opts.namespace },
    spec: {
      region: opts.region,
      // Always emit sshKeyName: "" when unset — omitting it makes CAPA fall back
      // to a key pair literally named "default" (which won't exist), failing
      // every instance launch. "" means "no SSH key pair".
      sshKeyName: opts.sshKeyName ?? "",
      // With loadBalancerType DISABLED (hosted-CP workload clusters: k0smotron
      // exposes the API from the mgmt cluster) CAPA's validation webhook
      // REJECTS listener/ingress sub-fields — live-observed:
      // 'spec.controlPlaneLoadBalancer.additionalListeners: Invalid value'
      // denied the whole AWSCluster, so the VPC was never created. Emit the
      // bare type and nothing else in that case; the konnectivity listener +
      // rules below apply only to the standalone-CP NLB path.
      controlPlaneLoadBalancer:
        opts.loadBalancerType ===
        AwsClusterV1Beta2SpecControlPlaneLoadBalancerLoadBalancerType.DISABLED
          ? { loadBalancerType: opts.loadBalancerType }
          : {
        loadBalancerType: opts.loadBalancerType,
        ...(opts.loadBalancerScheme
          ? { scheme: opts.loadBalancerScheme }
          : {}),
        // Expose k0s's konnectivity server (8132) on the control-plane NLB. CAPA
        // only adds the 6443 (API) listener by default, so the konnectivity-agent
        // (a pod in the VPC) times out dialing <endpoint>:8132 → the API<->pod
        // tunnel never forms ("No agent available") → no logs/exec/port-forward
        // AND admission webhooks (cert-manager, CAPA, crossplane) are unreachable.
        additionalListeners: [{ port: 8132, protocol: LbListenerProtocol.TCP }],
        // ...and open 8132 on the NLB's OWN security group. additionalListeners
        // creates the listener + target group + registers the node (so the target
        // reads "healthy"), but does NOT open the port on the LB's security group —
        // so inbound 8132 is silently dropped at the NLB (i/o timeout) even though
        // the target is healthy. Scope it to the cluster's own traffic, not the
        // internet like 6443: the VPC CIDR (internal LB / same-VPC clients) and the
        // NAT gateway IPs (with an internet-facing LB, in-VPC nodes reach it via
        // NAT, so the LB sees the NAT EIP as source — this is the single-node
        // konnectivity hairpin: agent and server are on the same node). The
        // matching node-side 8132 rule is in additionalControlPlaneIngressRules.
        ingressRules: [
          {
            // CAPA auto-adds the API rule (6443 → 0.0.0.0/0 for an internet-facing
            // LB) ONLY when no custom controlPlaneLoadBalancer.ingressRules are
            // present. Specifying ANY ingressRules (the konnectivity 8132 rules
            // below) makes CAPA treat the list as authoritative and DROP that
            // default, leaving 6443 reachable only from the node's NAT hairpin — so
            // the management cluster (Kind/k0smotron) and operators can't reach the
            // API to initialize/reconcile it (K0sControlPlane never goes
            // controlPlaneInitialized). Re-add the API rule explicitly. The LB is
            // internet-facing by design; the k8s API enforces TLS client-cert auth.
            description: "kube API server",
            protocol: LbIngressProtocol.TCP,
            fromPort: 6443,
            toPort: 6443,
            cidrBlocks: ["0.0.0.0/0"],
          },
          {
            description: "konnectivity (API to pod tunnel)",
            protocol: LbIngressProtocol.TCP,
            fromPort: 8132,
            toPort: 8132,
            cidrBlocks: nodeCidrs,
          },
          {
            description: "konnectivity (API to pod tunnel via NAT)",
            protocol: LbIngressProtocol.TCP,
            fromPort: 8132,
            toPort: 8132,
            natGatewaysIPsSource: true,
          },
        ],
      },
      network: {
        vpc: {
          cidrBlock: opts.vpcCidr,
          // One NAT gateway/EIP per AZ — cap AZs on EIP-constrained accounts.
          ...(opts.availabilityZoneUsageLimit
            ? {
                availabilityZoneUsageLimit: opts.availabilityZoneUsageLimit,
                availabilityZoneSelection: AzSelection.ORDERED,
              }
            : {}),
        },
        // Explicit subnets (existing 1a + added AZs): CAPA adopts existing ones by
        // AZ+CIDR and creates the rest. Required to grow AZs on a LIVE cluster, since
        // availabilityZoneUsageLimit only auto-derives subnets at VPC creation.
        ...(opts.subnets?.length ? { subnets: opts.subnets } : {}),
        // CAPA's control-plane security group opens the standard k8s/etcd ports
        // (6443, 2379-2380) but NOT k0s's controller-join API on 9443. Without
        // this, a 2nd/3rd K0sControlPlane replica hangs at "Joining existing
        // cluster via https://<cp>:9443" and never joins (HA stuck at 1 node).
        // Open 9443 between nodes in the VPC so HA control planes can form.
        additionalControlPlaneIngressRules: [
          {
            description: "k0s controller-join API (HA control plane)",
            protocol: IngressProtocol.TCP,
            fromPort: 9443,
            toPort: 9443,
            cidrBlocks: nodeCidrs,
          },
          {
            // konnectivity server (API<->pod tunnel). Pairs with the 8132 NLB
            // listener above; without this SG rule the agent's connection to the
            // NLB target times out and the tunnel never forms.
            // NB: AWS SG rule descriptions reject '>' (allowed set is
            // a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*), so the description must not
            // contain a "->" arrow or the whole authorize call is rejected.
            description: "konnectivity (API to pod tunnel)",
            protocol: IngressProtocol.TCP,
            fromPort: 8132,
            toPort: 8132,
            cidrBlocks: nodeCidrs,
          },
          // node-exporter (:9100) and kube-proxy (:10249) serve /metrics on the
          // node's hostNetwork. Same gap as 9443/8132 above: CAPA's control-plane
          // SG opens the standard k8s/etcd ports but NOT these, so Prometheus
          // (which runs on ONE control-plane node) can scrape only its OWN node's
          // exporter — every cross-node (i.e. cross-AZ) target is dropped by the SG
          // → TargetDown fires for 2/3 of the targets. Open them between nodes in
          // the VPC so every control-plane node is scrapeable. Purely intra-cluster
          // (nodeCidrs), never internet-exposed.
          {
            description: "node-exporter metrics (Prometheus scrape)",
            protocol: IngressProtocol.TCP,
            fromPort: 9100,
            toPort: 9100,
            cidrBlocks: nodeCidrs,
          },
          {
            description: "kube-proxy metrics (Prometheus scrape)",
            protocol: IngressProtocol.TCP,
            fromPort: 10249,
            toPort: 10249,
            cidrBlocks: nodeCidrs,
          },
        ],
        // Opt-in extra node-SG rules (e.g. public P2P ports). The friendly
        // protocol strings are the CAPA enum's literal values, so a cast maps
        // them onto the generated type.
        ...(opts.additionalNodeIngressRules?.length
          ? {
              additionalNodeIngressRules: opts.additionalNodeIngressRules.map(
                (r) => ({
                  description: r.description,
                  protocol: r.protocol as NodeIngressProtocol,
                  fromPort: r.fromPort,
                  toPort: r.toPort,
                  cidrBlocks: r.cidrBlocks,
                }),
              ),
            }
          : {}),
      },
    },
  });

  // secondaryCidrBlocks postdates the generated cdk8s CRD types, so inject it via a
  // JsonPatch (the live CAPA v2.11.1 CRD accepts it; CAPA associates the block on the
  // existing VPC). The added-AZ subnets above are carved from these blocks.
  if (opts.secondaryCidrBlocks?.length) {
    cr.addJsonPatch(
      JsonPatch.add(
        "/spec/network/vpc/secondaryCidrBlocks",
        opts.secondaryCidrBlocks.map((c) => ({ ipv4CidrBlock: c })),
      ),
    );
  }
  return cr;
}

/**
 * Emit an `AWSMachineTemplate` CR (worker or control-plane). CAPA places nodes
 * in the subnets it created, so no subnet/SG filters are needed.
 */
export function emitAwsMachineTemplate(
  scope: Construct,
  id: string,
  opts: {
    name: string;
    namespace: string;
    instanceType: string;
    iamInstanceProfile: string;
    publicIp: boolean;
    sshKeyName?: string;
    rootVolumeSizeGiB: number;
    rootVolumeType: string;
    ami?: AmiSelection;
    /**
     * Run the instances as EC2 Spot. `true` (or `{}`) caps the bid at the
     * on-demand price; `{ maxPrice: "0.20" }` sets an explicit USD/hour cap.
     * Default off (on-demand).
     */
    spot?: SpotSelection;
    /**
     * Allow pod-networked workloads on the node to reach IMDS (for keyless
     * instance-profile auth). Off by default — only the keyless management
     * control plane needs it; ordinary worker nodes should NOT expose their
     * instance role to every pod. See the field comment below.
     */
    imdsPodAccess?: boolean;
  },
): AwsMachineTemplateV1Beta2 {
  return new AwsMachineTemplateV1Beta2(scope, id, {
    metadata: { name: opts.name, namespace: opts.namespace },
    spec: {
      template: {
        spec: {
          instanceType: opts.instanceType,
          iamInstanceProfile: opts.iamInstanceProfile,
          publicIp: opts.publicIp,
          // Put bootstrap data directly in EC2 user-data instead of CAPA's default
          // Secrets Manager backend. That backend's boot script fetches the data
          // with the `aws` CLI, which a plain Ubuntu cloud image does NOT ship —
          // so the fetch dies, /etc/secret-userdata.txt is never written, and k0s
          // never installs. k0s bootstrap data is ~13KB, well under the 16KB
          // user-data cap. Also removes the node's dependency on secretsmanager IAM.
          cloudInit: { insecureSkipSecretsManager: true },
          // "" (not omitted) so CAPA does not fall back to the "default" key pair.
          sshKeyName: opts.sshKeyName ?? "",
          // KEYLESS-only (imdsPodAccess): let pod-networked controllers reach the
          // EC2 Instance Metadata Service (IMDS) for instance-profile auth.
          // Crossplane provider-aws and the CAPA controller run as ordinary pods;
          // their IMDS request crosses the CNI bridge, which adds one network hop,
          // so the EC2 default hop limit of 1 drops it (TTL→0 at the bridge) and
          // the AWS SDK finds no credentials even with a correct role. Hop limit 2
          // lets the request through. httpTokens=required enforces IMDSv2 (the token
          // PUT response also respects the hop limit, so pod auth still works) — a
          // GET-only SSRF then cannot read the near-admin instance-profile creds.
          // Omitted entirely for non-keyless nodes (workers), which keep the EC2
          // default (hop limit 1) and do NOT expose their role to pods.
          ...(opts.imdsPodAccess
            ? {
                instanceMetadataOptions: {
                  httpEndpoint: ImdsHttpEndpoint.ENABLED,
                  httpTokens: ImdsHttpTokens.REQUIRED,
                  httpPutResponseHopLimit: 2,
                },
              }
            : {}),
          rootVolume: {
            size: opts.rootVolumeSizeGiB,
            type: opts.rootVolumeType,
          },
          // Spot capacity: an EMPTY spotMarketOptions means "spot, bid capped
          // at the on-demand price" (CAPA/EC2 semantics); maxPrice tightens the
          // cap. Omitted entirely for on-demand pools.
          ...(opts.spot
            ? {
                spotMarketOptions:
                  typeof opts.spot === "object" && opts.spot.maxPrice
                    ? { maxPrice: opts.spot.maxPrice }
                    : {},
              }
            : {}),
          ...buildAmiSpec(opts.ami),
        },
      },
    },
  });
}
