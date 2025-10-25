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
  /** Kubernetes node labels to set on the kubelet at registration time */
  nodeLabels?: Record<string, string>;
  /** Kubernetes node taints to set at registration time */
  nodeTaints?: { key: string; value?: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' }[];
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

    function stableShortHash(input: string): string {
      let hash = 0x811c9dc5;
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
      }
      return ('0000000' + hash.toString(16)).slice(-8);
    }

    const baseLabels = args.labels || {};
    const mergedLabels: Record<string, pulumi.Input<string>> = {
      ...baseLabels,
      'constellation-uid': args.uid,
      'constellation-role': args.role,
      'constellation-node-group': args.nodeGroupName,
    };

    // Build kubelet node labels/taints to ensure scheduling constraints for system/worker separation
    // Preserve computed labels/taints for future use, but don't inject via kube-env
    // Reserved for future: merge user labels for node scheduling; currently not injected via metadata
    // const defaultNodeLabels: Record<string, string> = (args.role === 'worker') ? { 'node.kubernetes.io/worker': 'true' } : {};
    // const effectiveNodeLabels = { ...defaultNodeLabels, ...(args.nodeLabels || {}) };

    const metadata: Record<string, pulumi.Input<string>> = {
      'serial-port-enable': 'TRUE',
    };
    if (args.initSecret != null) {
      metadata['constellation-init-secret-hash'] = pulumi.output(args.initSecret).apply(async (secret) => {
        const bcrypt = await import('bcryptjs');
        // Generate deterministic salt based on stable inputs
        const saltInputs = [
          args.baseName,
          args.nodeGroupName,
          args.uid,
          'constellation-init-secret-salt'
        ].join('|');
        
        // Create deterministic salt using same hash algorithm as init secret
        let hash = 0x811c9dc5; // FNV-1a offset basis
        for (let i = 0; i < saltInputs.length; i++) {
          hash ^= saltInputs.charCodeAt(i);
          hash = (hash * 0x01000193) >>> 0; // FNV-1a prime
        }
        
        // Convert to base64-like string for salt
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./';
        let salt = '$2a$10$'; // bcrypt format
        let tempHash = Math.abs(hash);
        for (let i = 0; i < 22; i++) { // 22 chars for bcrypt salt
          salt += chars[tempHash % chars.length];
          tempHash = Math.floor(tempHash / chars.length);
          if (tempHash === 0) tempHash = Math.abs(hash) + i;
        }
        
        return bcrypt.default.hashSync(String(secret), salt);
      });
    }
    if (args.customEndpoint) metadata['custom-endpoint'] = args.customEndpoint;
    if (args.ccTechnology) metadata['cc-technology'] = args.ccTechnology;

    const isConfidential = Boolean(args.ccTechnology);
    const scheduling: any = isConfidential
      ? { automaticRestart: false, onHostMaintenance: 'TERMINATE' }
      : { automaticRestart: true, onHostMaintenance: 'MIGRATE' };

    // Build tags; prefer explicitly provided tags from infra (e.g., Firewall outputs)
    const baseTags = args.role === 'control-plane' ? [ 'control-plane' ] : [ 'worker' ];
    const dynamicTags = pulumi.output(args.uid).apply(u => baseTags.concat([`constellation-${u}`]));
    const computedTags: pulumi.Input<pulumi.Input<string>[]> = args.tags || (dynamicTags as any);

    // Derive a deterministic suffix from immutable template inputs so the
    // template name only changes when its effective configuration changes.
    const deterministicSuffix = pulumi.all([
      args.instanceType,
      computedTags as any,
      mergedLabels as any,
      args.imageId,
      (args.diskType ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskType!),
      (args.diskSize ?? defaultValues.gcp?.infra?.nodeGroups?.[0]?.diskSize!),
      args.network,
      args.subnetwork,
      args.aliasIpRangeName,
      args.aliasIpRangeMask,
      metadata as any,
      (args.iamServiceAccountVm || ''),
      JSON.stringify(scheduling),
      (args.ccTechnology || ''),
    ]).apply(values => stableShortHash(JSON.stringify(values)));

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
        autoDelete: false,
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
      statefulDisks: [ { deviceName: 'state-disk', deleteRule: 'ON_PERMANENT_INSTANCE_DELETION' } as any ],
      autoHealingPolicies: undefined as any,
      waitForInstances: true,
      ...(args.namedPorts && args.namedPorts.length > 0 ? { namedPorts: args.namedPorts.map(np => ({ name: np.name, port: np.port } as any)) } : {}),
      updatePolicy: {
        minimalAction: 'REPLACE',
        type: 'PROACTIVE',
        replacementMethod: 'RECREATE',
        maxSurgeFixed: 0, // Must be 0 when replacementMethod is RECREATE
        maxUnavailableFixed: 1, // Only 1 instance unavailable at a time
        minReadySec: 300, // Wait 5 minutes for new instances to be ready
      },
    }, {
      parent: this,
      dependsOn: [this.template], // Ensure manager depends on template for proper ordering
      deleteBeforeReplace: false, // Update MIG in-place to preserve stateful disk mapping
      customTimeouts: { create: '120m', update: '120m', delete: '60m' },
      protect: false,
    });

    this.instanceGroupUrl = this.mig.instanceGroup;

    this.registerOutputs({
      instanceGroupUrl: this.instanceGroupUrl,
      instanceTemplate: this.template.selfLink,
    });
  }
}