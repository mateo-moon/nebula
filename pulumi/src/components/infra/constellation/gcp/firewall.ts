import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface FirewallConfig {
  name: string; // baseName with suffix
  networkId: pulumi.Input<string>;
  nodesCidr: string; // e.g., 192.168.178.0/24
  podsCidr: string;  // e.g., 10.10.0.0/16
  internalLoadBalancer?: boolean;
  /** When using an Internal TCP/UDP Load Balancer, allow probes from the proxy-only subnet */
  proxyCidr?: pulumi.Input<string>;
  /** Optional target tags to scope rules to control-plane and worker nodes */
  targetTags?: { controlPlane: pulumi.Input<string>[]; worker: pulumi.Input<string>[] };
  controlPlanePorts?: Array<{ name: string; port: number; healthCheck: 'TCP' | 'HTTPS' }>; // defaults
  includeNodePortRange?: boolean; // default true
  debug?: boolean; // open 4000 if true
  emergencySsh?: boolean; // open 22 if true
  /** Optional: explicit base for GCP firewall rule names; when set, external rule becomes `${ruleNameBase}-external`, internal `-nodes`/`-pods` follow base. */
  ruleNameBase?: pulumi.Input<string>;
  uid?: pulumi.Input<string>;
}

export class Firewall extends pulumi.ComponentResource {
  public readonly external: gcp.compute.Firewall;
  public readonly internalNodes: gcp.compute.Firewall;
  public readonly internalPods: gcp.compute.Firewall;
  public readonly internalProxy?: gcp.compute.Firewall;
  public readonly controlPlaneTags?: pulumi.Output<string[]>;
  public readonly workerTags?: pulumi.Output<string[]>;

  constructor(name: string, args: FirewallConfig, opts?: pulumi.ComponentResourceOptions) {
    super('firewall', name, args, opts);

    const cpPorts = (args.controlPlanePorts && args.controlPlanePorts.length > 0)
      ? args.controlPlanePorts
      : [
          { name: 'kubernetes', port: 6443, healthCheck: 'HTTPS' as const },
          { name: 'bootstrapper', port: 9000, healthCheck: 'TCP' as const },
          { name: 'verify', port: 30081, healthCheck: 'TCP' as const },
          { name: 'konnectivity', port: 8132, healthCheck: 'TCP' as const },
          { name: 'recovery', port: 9999, healthCheck: 'TCP' as const },
          { name: 'join', port: 30090, healthCheck: 'TCP' as const },
        ];

    const externalPorts: Array<number | string> = [
      ...cpPorts.map(p => p.port),
      ...(args.debug ? [4000] : []),
      ...(args.emergencySsh ? [22] : []),
      ...(args.includeNodePortRange === false ? [] : ['30000-32767']),
    ];

    const ruleBase: pulumi.Input<string> = args.ruleNameBase ?? (args.uid ? pulumi.interpolate`${args.name}-${args.uid}` : args.name);
    this.external = new gcp.compute.Firewall(args.name, {
      name: pulumi.interpolate`${ruleBase}-external`,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: ['0.0.0.0/0'],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: externalPorts.map(p => String(p)) }],
      ...(args.targetTags?.controlPlane ? { targetTags: args.targetTags.controlPlane as any } : {}),
    }, { parent: this });

    const internalTargetTags = args.targetTags
      ? pulumi.all([args.targetTags.controlPlane, args.targetTags.worker]).apply(([a, b]) => ([] as string[]).concat(a || [], b || []))
      : undefined;

    this.internalNodes = new gcp.compute.Firewall(`${args.name}-nodes`, {
      name: pulumi.interpolate`${ruleBase}-nodes`,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: [args.nodesCidr],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
      ...(internalTargetTags ? { targetTags: internalTargetTags as any } : {}),
    }, { parent: this });

    this.internalPods = new gcp.compute.Firewall(`${args.name}-pods`, {
      name: pulumi.interpolate`${ruleBase}-pods`,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: [args.podsCidr],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
      ...(internalTargetTags ? { targetTags: internalTargetTags as any } : {}),
    }, { parent: this });

    // Allow ILB proxy-only subnet to reach backends for health checks (internal TCP/UDP LB)
    if (args.proxyCidr) {
      this.internalProxy = new gcp.compute.Firewall(`${args.name}-proxy`, {
        name: pulumi.interpolate`${ruleBase}-proxy`,
        description: 'Constellation VPC firewall (ILB proxy health checks)',
        network: args.networkId,
        sourceRanges: [args.proxyCidr],
        direction: 'INGRESS',
        allows: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
      }, { parent: this });
    }

    // Expose the tags we used so other components can consume them
    if (args.targetTags) {
      this.controlPlaneTags = pulumi.output(args.targetTags.controlPlane);
      this.workerTags = pulumi.output(args.targetTags.worker);
    }

    this.registerOutputs({
      controlPlaneTags: this.controlPlaneTags,
      workerTags: this.workerTags,
      externalRuleName: this.external.name,
      internalNodesRuleName: this.internalNodes.name,
      internalPodsRuleName: this.internalPods.name,
    });
  }
}


