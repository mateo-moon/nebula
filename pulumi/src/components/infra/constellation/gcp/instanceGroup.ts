import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as bcrypt from 'bcryptjs';

export interface NamedPortSpec { name: string; port: number; healthCheck?: 'TCP' | 'HTTPS' }

export interface InstanceGroupConfig {
  baseName: string;
  nodeGroupName: string;
  role: 'control-plane' | 'worker' | string;
  zone: string;
  uid: string;
  instanceType: string;
  initialCount: number;
  imageId: string; // selfLink or family
  diskSize?: number;
  diskType?: string; // e.g., pd-ssd, pd-standard
  network: pulumi.Input<string>;
  subnetwork: pulumi.Input<string>;
  aliasIpRangeName: pulumi.Input<string>;
  aliasIpRangeMask: pulumi.Input<string>; // e.g., '/16' per GCP requirement
  kubeEnv: string;
  debug?: boolean;
  namedPorts?: NamedPortSpec[];
  labels?: Record<string, string>;
  initSecret?: pulumi.Input<string>;
  customEndpoint?: string;
  ccTechnology?: string;
  iamServiceAccountVm?: pulumi.Input<string>; // email
}

export class InstanceGroup extends pulumi.ComponentResource {
  public readonly template: gcp.compute.InstanceTemplate;
  public readonly mig: gcp.compute.InstanceGroupManager;
  public readonly instanceGroupUrl: pulumi.Output<string>;

  constructor(name: string, args: InstanceGroupConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:InstanceGroup', name, args, opts);

    const baseLabels = args.labels || {};
    const mergedLabels: Record<string, string> = {
      ...baseLabels,
      'constellation-uid': args.uid,
      'constellation-role': args.role,
    };

    const metadata: Record<string, pulumi.Input<string>> = {
      'kube-env': args.kubeEnv,
      'serial-port-enable': 'TRUE',
    };
    if (args.initSecret != null) {
      const seed = `${args.baseName}-${args.nodeGroupName}`;
      metadata['constellation-init-secret-hash'] = pulumi.output(args.initSecret).apply((secret) => bcrypt.hashSync(String(secret), seed));
    }
    if (args.customEndpoint) metadata['custom-endpoint'] = args.customEndpoint;
    if (args.ccTechnology) metadata['cc-technology'] = args.ccTechnology;

    const isConfidential = Boolean(args.ccTechnology);
    const scheduling: any = isConfidential
      ? { automaticRestart: false, onHostMaintenance: 'TERMINATE' }
      : { automaticRestart: true, onHostMaintenance: 'MIGRATE' };

    const immutablesKey = JSON.stringify({
      machineType: args.instanceType,
      bootDiskType: args.diskType ?? 'pd-ssd',
      bootDiskSize: args.diskSize ?? 40,
      imageId: args.imageId,
      cc: args.ccTechnology || '',
    });
    let hash = 0x811c9dc5;
    for (let i = 0; i < immutablesKey.length; i++) {
      hash ^= immutablesKey.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    const suffix = ('0000000' + hash.toString(16)).slice(-8);
    const templatePrefix = `${args.baseName}-${args.nodeGroupName}-${suffix}-`;

    this.template = new gcp.compute.InstanceTemplate(templatePrefix, {
      namePrefix: templatePrefix,
      machineType: args.instanceType,
      tags: args.role === 'control-plane' ? [ 'control-plane' ] : [ 'worker' ],
      labels: mergedLabels,
      ...(args.ccTechnology ? { confidentialInstanceConfig: {
        enableConfidentialCompute: true,
        confidentialInstanceType: args.ccTechnology,
      } as any } : {}),
      ...(args.ccTechnology ? { minCpuPlatform: 'AMD Milan' } : {}),
      disks: [{
        boot: true,
        autoDelete: true,
        sourceImage: args.imageId,
        diskSizeGb: 40,
        diskType: 'pd-ssd',
      }, {
        // Constellation expects a state disk named 'state-disk'
        autoDelete: false,
        boot: false,
        deviceName: 'state-disk',
        diskType: args.diskType ?? 'pd-ssd',
        diskSizeGb: args.diskSize ?? 40,
        type: 'PERSISTENT'
      }],
      networkInterfaces: [{
        network: args.network,
        subnetwork: args.subnetwork,
        aliasIpRanges: [{ subnetworkRangeName: args.aliasIpRangeName, ipCidrRange: args.aliasIpRangeMask }],
        // Access config omitted: nodes should be private by default
      }],
      metadata,
      ...(args.iamServiceAccountVm ? { serviceAccount: {
        email: args.iamServiceAccountVm,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      } as any } : {}),
      scheduling,
      canIpForward: false,
    }, { parent: this, deleteBeforeReplace: false });

    this.mig = new gcp.compute.InstanceGroupManager(`${args.baseName}-${args.nodeGroupName}`, {
      name: `${args.baseName}-${args.nodeGroupName}`,
      baseInstanceName: `${args.baseName}-${args.nodeGroupName}`,
      zone: args.zone,
      versions: [{ instanceTemplate: this.template.selfLinkUnique }],
      targetSize: args.initialCount,
      statefulDisks: [ { deviceName: 'state-disk', deleteRule: 'NEVER' } as any ],
      autoHealingPolicies: undefined as any,
      waitForInstances: false,
      ...(args.namedPorts && args.namedPorts.length > 0 ? { namedPorts: args.namedPorts.map(np => ({ name: np.name, port: np.port } as any)) } : {}),
      updatePolicy: {
        minimalAction: 'NONE',
        type: 'OPPORTUNISTIC',
        replacementMethod: 'NONE',
        maxSurgePercent: 0,
        maxUnavailablePercent: 100,
      },
    }, { parent: this, dependsOn: [this.template] });

    this.instanceGroupUrl = this.mig.instanceGroup;

    this.registerOutputs({
      instanceGroupUrl: this.instanceGroupUrl,
      instanceTemplate: this.template.selfLink,
    });
  }
}