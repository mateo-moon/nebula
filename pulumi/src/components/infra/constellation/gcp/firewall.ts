import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface FirewallConfig {
  name: string; // baseName with suffix
  networkId: pulumi.Input<string>;
  nodesCidr: string; // e.g., 192.168.178.0/24
  podsCidr: string;  // e.g., 10.10.0.0/16
  internalLoadBalancer?: boolean;
  controlPlanePorts?: Array<{ name: string; port: number; healthCheck: 'TCP' | 'HTTPS' }>; // defaults
  includeNodePortRange?: boolean; // default true
  debug?: boolean; // open 4000 if true
  emergencySsh?: boolean; // open 22 if true
}

export class Firewall extends pulumi.ComponentResource {
  public readonly external: gcp.compute.Firewall;
  public readonly internalNodes: gcp.compute.Firewall;
  public readonly internalPods: gcp.compute.Firewall;

  constructor(name: string, args: FirewallConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:Firewall', name, args, opts);

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

    this.external = new gcp.compute.Firewall(args.name, {
      name: args.name,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: ['0.0.0.0/0'],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: externalPorts.map(p => String(p)) }],
    }, { parent: this });

    this.internalNodes = new gcp.compute.Firewall(`${args.name}-nodes`, {
      name: `${args.name}-nodes`,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: [args.nodesCidr],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
    }, { parent: this });

    this.internalPods = new gcp.compute.Firewall(`${args.name}-pods`, {
      name: `${args.name}-pods`,
      description: 'Constellation VPC firewall',
      network: args.networkId,
      sourceRanges: [args.podsCidr],
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp' }, { protocol: 'udp' }, { protocol: 'icmp' }],
    }, { parent: this });

    this.registerOutputs({});
  }
}


