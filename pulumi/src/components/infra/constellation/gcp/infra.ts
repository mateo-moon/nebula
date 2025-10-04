import * as pulumi from '@pulumi/pulumi';
import { ConstellationGcpNetwork, type ConstellationGcpNetworkConfig } from './network';
import { RouterNat } from './routerNat';
import { Firewall } from './firewall';
import { Addresses } from './addresses';
import { InstanceGroup } from './instanceGroup';
import { JumpHost } from './jumpHost';
import { PublicLoadBalancer } from './loadbalancerPublic';
import { InternalLoadBalancer } from './loadbalancerInternal';

export interface GcpConstellationInfraConfig {
  region: string;
  zone: string;
  internalLoadBalancer?: boolean;
  name?: string;
  labels?: Record<string, string>;

  network?: Omit<ConstellationGcpNetworkConfig, 'region' | 'internalLoadBalancer'>;

  nodeGroups: Array<{
    name: string;
    role: 'control-plane' | 'worker' | string;
    zone?: string; // defaults to top-level zone
    instanceType: string;
    initialCount: number;
    diskSize?: number;
    diskType?: string;
  }>;

  imageId?: string;
  kubeEnv?: string;
  uid?: string;
  initSecret?: string;
  customEndpoint?: string;
  ccTechnology?: string;
  iamServiceAccountVm?: pulumi.Input<string>;
  debug?: boolean;
}

export class GcpConstellationInfra extends pulumi.ComponentResource {
  public readonly network: ConstellationGcpNetwork;
  public readonly routerNat: RouterNat;
  public readonly addresses: Addresses;
  public readonly instanceGroups: Record<string, InstanceGroup> = {};
  public readonly controlPlaneInstanceGroups: pulumi.Output<string>[] = [];
  public readonly inClusterEndpoint: pulumi.Output<string>;
  public readonly outOfClusterEndpoint: pulumi.Output<string>;

  constructor(name: string, args: GcpConstellationInfraConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:Infra', name, args, opts);

    this.network = new ConstellationGcpNetwork(name, {
      name,
      region: args.region,
      ...(args.network || {}),
      ...(args.internalLoadBalancer !== undefined ? { internalLoadBalancer: args.internalLoadBalancer } : {}),
    }, { parent: this });

    this.routerNat = new RouterNat(name, {
      name,
      region: args.region,
      networkId: this.network.network.id,
    }, { parent: this });

    const fwCfg: any = {
      name,
      networkId: this.network.network.id,
      nodesCidr: args.network?.ipCidrNodes || '192.168.178.0/24',
      podsCidr: args.network?.ipCidrPods || '10.10.0.0/16',
      debug: !!args.debug,
      emergencySsh: !!args.internalLoadBalancer,
    };
    if (args.internalLoadBalancer !== undefined) fwCfg.internalLoadBalancer = args.internalLoadBalancer;
    new Firewall(name, fwCfg, { parent: this });

    const addrCfg: any = {
      name,
      region: args.region,
      ilbSubnetworkId: this.network.ilbSubnetwork?.id,
    };
    if (args.internalLoadBalancer !== undefined) addrCfg.internalLoadBalancer = args.internalLoadBalancer;
    this.addresses = new Addresses(name, addrCfg, { parent: this });

    // Instance groups
    args.nodeGroups.forEach(ng => {
      const diskSize = ng.diskSize ?? 40;
      const instanceType = ng.instanceType ?? 'n2d-standard-4';
      const igArgs: any = {
        baseName: name,
        nodeGroupName: ng.name,
        role: ng.role,
        zone: ng.zone || args.zone,
        uid: args.uid,
        instanceType,
        initialCount: ng.initialCount,
        imageId: args.imageId,
        diskSize,
        network: this.network.network.id,
        subnetwork: this.network.nodesSubnetwork.id,
        aliasIpRangeName: this.network.nodesSubnetwork.secondaryIpRanges.apply(r => r?.[0]?.rangeName || (this.network.podsRangeName as string)),
        // Allocate a per-node alias IP block; default to /24 to avoid exhausting the whole secondary range
        aliasIpRangeMask: '/24',
        kubeEnv: args.kubeEnv,
        debug: !!args.debug,
        namedPorts: ng.role === 'control-plane' ? [
          { name: 'kubernetes', port: 6443 },
          { name: 'bootstrapper', port: 9000 },
          { name: 'verify', port: 30081 },
          { name: 'konnectivity', port: 8132 },
          { name: 'recovery', port: 9999 },
          { name: 'join', port: 30090 },
        ] : [],
        labels: args.labels,
        initSecret: args.initSecret,
        customEndpoint: args.customEndpoint,
        ccTechnology: args.ccTechnology ?? 'SEV_SNP',
        iamServiceAccountVm: args.iamServiceAccountVm,
      };
      if (ng.diskType !== undefined) igArgs.diskType = ng.diskType;
      const ig = new InstanceGroup(`${name}-${ng.name}`, igArgs, { parent: this });
      this.instanceGroups[ng.name] = ig;
      if (ng.role === 'control-plane') this.controlPlaneInstanceGroups.push(ig.instanceGroupUrl);
    });

    // LBs
    const inClusterEndpoint = args.internalLoadBalancer
      ? this.addresses.internalAddress!.address as pulumi.Output<string>
      : this.addresses.globalAddress!.address as pulumi.Output<string>;
    let outOfClusterEndpoint: pulumi.Output<string> = inClusterEndpoint;
    if (args.internalLoadBalancer && args.debug) {
      const jh = new JumpHost(`${name}-jump`, {
        baseName: name,
        zone: args.zone,
        subnetwork: this.network.nodesSubnetwork.id,
        ...(args.labels ? { labels: args.labels } : {}),
        lbInternalIp: this.addresses.internalAddress!.address,
      }, { parent: this });
      outOfClusterEndpoint = jh.instance.networkInterfaces.apply(nis => String(nis?.[0]?.accessConfigs?.[0]?.natIp || '')) as pulumi.Output<string>;
    }

    if (args.internalLoadBalancer) {
      (['kubernetes','bootstrapper','verify','konnectivity','recovery','join'] as const).forEach((nameKey) => {
        const portMap: Record<string, number> = {
          kubernetes: 6443,
          bootstrapper: 9000,
          verify: 30081,
          konnectivity: 8132,
          recovery: 9999,
          join: 30090,
        };
        new InternalLoadBalancer(`${name}-${nameKey}`, {
          name,
          region: args.region,
          backendPortName: nameKey,
          port: portMap[nameKey]!,
          healthCheck: nameKey === 'kubernetes' ? 'HTTPS' : 'TCP',
          backendInstanceGroup: this.instanceGroups['control-plane']!.instanceGroupUrl,
          ipAddressSelfLink: this.addresses.internalAddress!.selfLink,
          networkId: this.network.network.id,
          backendSubnetId: this.network.ilbSubnetwork!.id,
        }, { parent: this });
      });
    } else {
      (['kubernetes','bootstrapper','verify','konnectivity','recovery','join'] as const).forEach((nameKey) => {
        const portMap: Record<string, number> = {
          kubernetes: 6443,
          bootstrapper: 9000,
          verify: 30081,
          konnectivity: 8132,
          recovery: 9999,
          join: 30090,
        };
        const lbArgs: any = {
          name,
          backendPortName: nameKey,
          port: portMap[nameKey]!,
          healthCheck: nameKey === 'kubernetes' ? 'HTTPS' : 'TCP',
          backendInstanceGroups: this.controlPlaneInstanceGroups,
          ipAddress: this.addresses.globalAddress!.selfLink,
          region: args.region,
        };
        if (args.labels) lbArgs.labels = { ...args.labels, 'constellation-use': nameKey };
        new PublicLoadBalancer(`${name}-${nameKey}`, lbArgs, { parent: this });
      });
    }

    this.inClusterEndpoint = inClusterEndpoint;
    this.outOfClusterEndpoint = outOfClusterEndpoint;

    this.registerOutputs({
      networkId: this.network.network.id,
      nodesSubnetworkId: this.network.nodesSubnetwork.id,
      inClusterEndpoint: this.inClusterEndpoint,
      outOfClusterEndpoint: this.outOfClusterEndpoint,
    });
  }
}


