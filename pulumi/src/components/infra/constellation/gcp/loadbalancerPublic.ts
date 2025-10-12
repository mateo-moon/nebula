import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { defaultValues } from '../index';

export interface PublicLbConfig {
  name: string;
  backendPortName: string; // e.g., kubernetes, bootstrapper, verify, etc.
  port: number;
  healthCheck: 'TCP' | 'HTTPS';
  backendInstanceGroups: pulumi.Input<string>[];
  ipAddress: pulumi.Input<string>;
  labels?: Record<string, string>;
  uid?: pulumi.Input<string>; // Constellation cluster UID
  // Optional backend session affinity policy; defaults to 'NONE'
  sessionAffinity?: 'NONE' | 'CLIENT_IP' | 'CLIENT_IP_PORT_PROTO' | 'CLIENT_IP_PROTO';
  // Optional utilization target for UTILIZATION balancing mode
  backendMaxUtilization?: number; // default 0.8
  // HTTPS health check enhancements
  healthCheckPath?: string; // e.g., '/livez' for apiserver
  healthCheckHost?: string;
  healthCheckConfig?: {
    checkIntervalSec?: number;
    timeoutSec?: number;
    healthyThreshold?: number;
    unhealthyThreshold?: number;
  };
}

export class PublicLoadBalancer extends pulumi.ComponentResource {
  public readonly backend: gcp.compute.BackendService;
  public readonly hcTcp?: gcp.compute.HealthCheck;
  public readonly hcHttps?: gcp.compute.HealthCheck;
  public readonly forwardingRule: gcp.compute.GlobalForwardingRule;
  public readonly tcpProxy?: gcp.compute.TargetTCPProxy;

  constructor(name: string, args: PublicLbConfig, opts?: pulumi.ComponentResourceOptions) {
    super('publicLoadBalancer', name, args, opts);

    const hcName = `${args.name}-${args.backendPortName}-hc`;
    const hcParams = {
      // Align defaults with Terraform module: slower and more stable by default
      checkIntervalSec: args.healthCheckConfig?.checkIntervalSec ?? 5,
      timeoutSec: args.healthCheckConfig?.timeoutSec ?? 5,
      healthyThreshold: args.healthCheckConfig?.healthyThreshold ?? 2,
      unhealthyThreshold: args.healthCheckConfig?.unhealthyThreshold ?? 2,
    };
    if (args.healthCheck === 'TCP') {
      this.hcTcp = new gcp.compute.HealthCheck(hcName, {
        name: hcName,
        tcpHealthCheck: { port: args.port },
        checkIntervalSec: hcParams.checkIntervalSec,
        timeoutSec: hcParams.timeoutSec,
        healthyThreshold: hcParams.healthyThreshold,
        unhealthyThreshold: hcParams.unhealthyThreshold,
      }, { parent: this });
    } else {
      const https: any = { port: args.port };
      if (args.healthCheckPath) https.requestPath = args.healthCheckPath;
      if (args.healthCheckHost) https.host = args.healthCheckHost as any;
      this.hcHttps = new gcp.compute.HealthCheck(hcName, {
        name: hcName,
        httpsHealthCheck: https,
        checkIntervalSec: hcParams.checkIntervalSec,
        timeoutSec: hcParams.timeoutSec,
        healthyThreshold: hcParams.healthyThreshold,
        unhealthyThreshold: hcParams.unhealthyThreshold,
      }, { parent: this });
    }

    const gBackendArgs: any = {
      name: args.uid ? pulumi.interpolate`${args.name}-${args.uid}-${args.backendPortName}` : `${args.name}-${args.backendPortName}`,
      protocol: 'TCP',
      loadBalancingScheme: 'EXTERNAL',
      portName: args.backendPortName,
      backends: args.backendInstanceGroups.map((ig) => ({
        group: ig,
        balancingMode: 'UTILIZATION',
        maxUtilization: typeof args.backendMaxUtilization === 'number' ? args.backendMaxUtilization : 0.8,
        capacityScaler: 1,
      })),
      healthChecks: (this.hcTcp?.selfLink ?? this.hcHttps!.selfLink),
      timeoutSec: 30,
      sessionAffinity: args.sessionAffinity || defaultValues.gcp?.loadBalancer?.sessionAffinity!,
    };
    this.backend = new gcp.compute.BackendService(`${args.name}-${args.backendPortName}`, gBackendArgs, { 
      parent: this, 
      dependsOn: [this.hcTcp ?? this.hcHttps!],
      deleteBeforeReplace: false
    });

    this.tcpProxy = new gcp.compute.TargetTCPProxy(`${args.name}-${args.backendPortName}`, {
      name: args.uid ? pulumi.interpolate`${args.name}-${args.uid}-${args.backendPortName}` : `${args.name}-${args.backendPortName}`,
      backendService: (this.backend as gcp.compute.BackendService).selfLink,
      proxyHeader: 'NONE',
    }, { 
      parent: this,
      deleteBeforeReplace: false
    });

    const gfrArgs: any = {
      name: args.uid ? pulumi.interpolate`${args.name}-${args.uid}-${args.backendPortName}` : `${args.name}-${args.backendPortName}`,
      ipAddress: args.ipAddress,
      ipProtocol: 'TCP',
      portRange: String(args.port),
      target: this.tcpProxy.selfLink,
    };
    
    // Add Constellation UID label if provided
    if (args.uid) {
      gfrArgs.labels = {
        'constellation-uid': args.uid,
        'constellation-use': args.backendPortName,
        ...(args.labels || {}),
      };
    } else if (args.labels) {
      gfrArgs.labels = args.labels;
    }
    
    this.forwardingRule = new gcp.compute.GlobalForwardingRule(`${args.name}-${args.backendPortName}`, gfrArgs, { 
      parent: this, 
      dependsOn: [this.tcpProxy],
      deleteBeforeReplace: true
    });

    this.registerOutputs({});
  }
}


