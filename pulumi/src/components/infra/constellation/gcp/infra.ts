import * as pulumi from '@pulumi/pulumi';
import { ConstellationGcpNetwork, type ConstellationGcpNetworkConfig } from './network';
import { RouterNat } from './routerNat';
import { Firewall } from './firewall';
import { Addresses } from './addresses';
import { InstanceGroup } from './instanceGroup';
// import { JumpHost } from './jumpHost';
// import { InternalLoadBalancer } from './loadbalancerInternal';
import { PublicLoadBalancer } from './loadbalancerPublic';
import { defaultValues } from '../index';

export interface GcpConstellationInfraConfig {
  region: string;
  zone: string;
  name?: string;
  labels?: Record<string, string>;

  network?: Omit<ConstellationGcpNetworkConfig, 'region'>;

  nodeGroups: Array<{
    name: string;
    role: 'control-plane' | 'worker' | string;
    zone?: string; // defaults to top-level zone
    instanceType: string;
    initialCount: number;
    diskSize?: number;
    diskType?: string;
    /** Kubernetes node labels to set on the kubelet at registration time */
    nodeLabels?: Record<string, string>;
    /** Kubernetes node taints to set at registration time */
    nodeTaints?: { key: string; value?: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' }[];
  }>;

  imageId?: string;
  kubeEnv?: string;
  uid?: pulumi.Input<string>;
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
  public readonly allInstanceGroups: pulumi.Output<string>[] = [];
  public readonly inClusterEndpoint: pulumi.Output<string>;
  public readonly outOfClusterEndpoint: pulumi.Output<string>;

  constructor(name: string, args: GcpConstellationInfraConfig, opts?: pulumi.ComponentResourceOptions) {
    super('gcpInfra', name, args, opts);

    this.network = new ConstellationGcpNetwork(name, {
      name,
      region: args.region,
      ...(args.uid ? { uid: args.uid } : {}),
      ...(args.network || {}),
    }, { parent: this });

    this.routerNat = new RouterNat(name, {
      name,
      region: args.region,
      networkId: this.network.network.id,
      ...(args.uid ? { uid: args.uid } : {}),
    }, { parent: this });

    const controlPlaneTags = [ `${name}-control-plane`, 'control-plane' ];
    const workerTags = [ `${name}-worker`, 'worker' ];
    const fwCfg: any = {
      name,
      networkId: this.network.network.id,
      nodesCidr: args.network?.ipCidrNodes || defaultValues.gcp?.network?.ipCidrNodes!,
      podsCidr: args.network?.ipCidrPods || defaultValues.gcp?.network?.ipCidrPods!,
      debug: !!args.debug,
      emergencySsh: false,
      // ensure firewall rule name base is stable and unique to the Constellation stack
      ruleNameBase: pulumi.interpolate`${name}-${args.region}`,
      targetTags: { controlPlane: controlPlaneTags, worker: workerTags },
      ...(args.uid ? { uid: args.uid } : {}),
    };
    const fw = new Firewall(name, fwCfg, { parent: this });

    const addrCfg: any = {
      name,
      region: args.region,
      ...(args.uid ? { uid: args.uid } : {}), // Pass Constellation UID to addresses
    };
    this.addresses = new Addresses(name, addrCfg, { parent: this });

    // Instance groups
    args.nodeGroups.forEach(ng => {
      const diskSize = ng.diskSize ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskSize!;
      const instanceType = ng.instanceType ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.instanceType!;
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
        ...(ng.nodeLabels ? { nodeLabels: ng.nodeLabels } : {}),
        ...(ng.nodeTaints ? { nodeTaints: ng.nodeTaints } : {}),
        initSecret: args.initSecret,
        customEndpoint: args.customEndpoint,
        ccTechnology: args.ccTechnology ?? defaultValues.gcp?.ccTechnology!,
        iamServiceAccountVm: args.iamServiceAccountVm,
      };
      if (ng.diskType !== undefined) igArgs.diskType = ng.diskType;
      // Wire tags from firewall outputs rather than synthesizing from uid
      igArgs.tags = (ng.role === 'control-plane') ? (fw.controlPlaneTags as any) : (fw.workerTags as any);
      const ig = new InstanceGroup(`${name}-${ng.name}`, igArgs, { parent: this });
      this.instanceGroups[ng.name] = ig;
      this.allInstanceGroups.push(ig.instanceGroupUrl);
      if (ng.role === 'control-plane') this.controlPlaneInstanceGroups.push(ig.instanceGroupUrl);
    });

    // LBs - Only create public load balancers
    const inClusterEndpoint = this.addresses.globalAddress!.address as pulumi.Output<string>;
    const outOfClusterEndpoint = this.addresses.globalAddress!.address as pulumi.Output<string>;

    const publicLbs: PublicLoadBalancer[] = [];
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
        uid: args.uid, // Pass Constellation UID to load balancer
        // Speed up initial healthy marking during bootstrap; can be tuned via config later
        healthCheckConfig: nameKey === 'bootstrapper' ? { checkIntervalSec: 2, timeoutSec: 2, healthyThreshold: 1, unhealthyThreshold: 5 } : undefined,
        ...(nameKey === 'kubernetes' ? { healthCheckPath: '/livez', healthCheckHost: '' } : {}),
      };
      if (args.labels) lbArgs.labels = { ...args.labels, 'constellation-use': nameKey };
      const lb = new PublicLoadBalancer(`${name}-${nameKey}`, lbArgs, { 
        parent: this,
        dependsOn: [this.addresses.globalAddress!],
        protect: false
      });
      publicLbs.push(lb);
    });

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


