import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { defaultValues } from '../index';

export interface NamedPortSpec { name: string; port: number; healthCheck?: 'TCP' | 'HTTPS' }

export interface InstanceGroupConfig {
  baseName: string;
  nodeGroupName: string;
  role: 'control-plane' | 'worker' | string;
  zone: string;
  uid: pulumi.Input<string>;
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
  /** Optional explicit network tags to apply to instances */
  tags?: pulumi.Input<pulumi.Input<string>[]>;
}

export class InstanceGroup extends pulumi.ComponentResource {
  public readonly template: gcp.compute.InstanceTemplate;
  public readonly mig: gcp.compute.InstanceGroupManager;
  public readonly instanceGroupUrl: pulumi.Output<string>;

  constructor(name: string, args: InstanceGroupConfig, opts?: pulumi.ComponentResourceOptions) {
    super('instanceGroup', name, args, opts);

    const baseLabels = args.labels || {};
    const mergedLabels: Record<string, pulumi.Input<string>> = {
      ...baseLabels,
      'constellation-uid': args.uid,
      'constellation-role': args.role,
      'constellation-node-group': args.nodeGroupName,
    };

    const autoscalerEnv = 'AUTOSCALER_ENV_VARS: kube_reserved=cpu=1060m,memory=1019Mi,ephemeral-storage=41Gi;node_labels=;os=linux;os_distribution=cos;evictionHard=';
    const kubeEnvCombined = args.kubeEnv ? `${args.kubeEnv}\n${autoscalerEnv}` : autoscalerEnv;
    const metadata: Record<string, pulumi.Input<string>> = {
      'kube-env': kubeEnvCombined,
      'serial-port-enable': 'TRUE',
    };
    if (args.initSecret != null) {
      metadata['constellation-init-secret-hash'] = pulumi.output(args.initSecret).apply(async (secret) => {
        const bcrypt = await import('bcryptjs');
        return bcrypt.default.hashSync(String(secret), 10);
      });
    }
    if (args.customEndpoint) metadata['custom-endpoint'] = args.customEndpoint;
    if (args.ccTechnology) metadata['cc-technology'] = args.ccTechnology;

    const isConfidential = Boolean(args.ccTechnology);
    const scheduling: any = isConfidential
      ? { automaticRestart: false, onHostMaintenance: 'TERMINATE' }
      : { automaticRestart: true, onHostMaintenance: 'MIGRATE' };

    const immutablesKey = JSON.stringify({
      machineType: args.instanceType,
      bootDiskType: args.diskType ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskType!,
      bootDiskSize: args.diskSize ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskSize!,
      imageId: args.imageId,
      cc: args.ccTechnology || '',
    });
    let hash = 0x811c9dc5;
    for (let i = 0; i < immutablesKey.length; i++) {
      hash ^= immutablesKey.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    
    // Build tags; prefer explicitly provided tags from infra (e.g., Firewall outputs)
    const baseTags = args.role === 'control-plane' ? [ 'control-plane' ] : [ 'worker' ];
    const dynamicTags = pulumi.output(args.uid).apply(u => baseTags.concat([`constellation-${u}`]));
    const computedTags: pulumi.Input<pulumi.Input<string>[]> = args.tags || (dynamicTags as any);

    // Generate deterministic suffix based on immutable properties to avoid naming conflicts
    const deterministicSuffix = pulumi.output(args.uid).apply(uid => {
      const suffixInputs = [
        args.baseName,
        args.nodeGroupName,
        uid,
        args.instanceType,
        args.imageId,
        args.diskType ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskType!,
        String(args.diskSize ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskSize!),
        args.ccTechnology || '',
      ].join('|');
      
      let hash = 0x811c9dc5; // FNV-1a offset basis
      for (let i = 0; i < suffixInputs.length; i++) {
        hash ^= suffixInputs.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // FNV-1a prime
      }
      // Convert to base36 and take first 6 characters
      return Math.abs(hash).toString(36).substring(0, 6);
    });

    this.template = new gcp.compute.InstanceTemplate(`${args.baseName}-${args.nodeGroupName}-template`, {
      name: pulumi.interpolate`${args.baseName}-${args.nodeGroupName}-${args.uid}-${deterministicSuffix}`,
      machineType: args.instanceType,
      tags: computedTags as any,
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
        diskSizeGb: 20,
        diskType: defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskType!,
      }, {
        // Constellation expects a state disk named 'state-disk'
        autoDelete: true,
        boot: false,
        deviceName: 'state-disk',
        diskType: args.diskType ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskType!,
        diskSizeGb: args.diskSize ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskSize!,
        type: 'PERSISTENT',
        mode: 'READ_WRITE'
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
    }, {
      parent: this,
      deleteBeforeReplace: false,
      replaceOnChanges: [
        'machineType',
        'tags',
        'labels',
        'metadata',
        'disks',
        'networkInterfaces',
        'serviceAccount',
        'scheduling',
      ],
    });

    this.mig = new gcp.compute.InstanceGroupManager(`${args.baseName}-${args.nodeGroupName}-mig`, {
      name: pulumi.interpolate`${args.baseName}-${args.nodeGroupName}-${args.uid}`,
      baseInstanceName: pulumi.interpolate`${args.baseName}-${args.nodeGroupName}-${args.uid}`,
      zone: args.zone,
      versions: [{ instanceTemplate: this.template.selfLink }],
      targetSize: args.initialCount,
      // statefulDisks: [ { deviceName: 'state-disk', deleteRule: 'NEVER' } as any ],
      autoHealingPolicies: undefined as any,
      waitForInstances: true,
      ...(args.namedPorts && args.namedPorts.length > 0 ? { namedPorts: args.namedPorts.map(np => ({ name: np.name, port: np.port } as any)) } : {}),
      updatePolicy: {
        minimalAction: 'REPLACE',
        type: 'PROACTIVE',
        replacementMethod: 'RECREATE',
        maxSurgeFixed: 0,
        maxUnavailableFixed: 1,
      },
    }, {
      parent: this,
      dependsOn: [this.template], // Ensure manager depends on template for proper ordering
      deleteBeforeReplace: true, // Delete manager before template replacement
      protect: false,
    });

    this.instanceGroupUrl = this.mig.instanceGroup;

    this.registerOutputs({
      instanceGroupUrl: this.instanceGroupUrl,
      instanceTemplate: this.template.selfLink,
    });
  }
}