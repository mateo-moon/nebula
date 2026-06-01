import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface InternalLbConfig {
  name: string;
  region: string;
  backendPortName: string;
  port: number;
  healthCheck: 'TCP' | 'HTTPS';
  backendInstanceGroup: pulumi.Input<string>;
  ipAddressSelfLink: pulumi.Input<string>;
  networkId: pulumi.Input<string>;
  backendSubnetId: pulumi.Input<string>;
  labels?: Record<string, string>;
}

export class InternalLoadBalancer extends pulumi.ComponentResource {
  public readonly backend: gcp.compute.RegionBackendService;
  public readonly hcTcp?: gcp.compute.HealthCheck;
  public readonly hcHttps?: gcp.compute.HealthCheck;
  public readonly forwardingRule: gcp.compute.ForwardingRule;

  constructor(name: string, args: InternalLbConfig, opts?: pulumi.ComponentResourceOptions) {
    super('internalLb', name, args, opts);

    const hcName = `${args.name}-${args.backendPortName}-hc`;
    if (args.healthCheck === 'TCP') {
      this.hcTcp = new gcp.compute.HealthCheck(hcName, {
        name: hcName,
        tcpHealthCheck: { port: args.port },
        checkIntervalSec: 5,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      }, { parent: this });
    } else {
      this.hcHttps = new gcp.compute.HealthCheck(hcName, {
        name: hcName,
        httpsHealthCheck: { port: args.port },
        checkIntervalSec: 5,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      }, { parent: this });
    }

    const backendArgs: any = {
      name: `${args.name}-${args.backendPortName}-int`,
      region: args.region,
      protocol: 'TCP',
      loadBalancingScheme: 'INTERNAL',
      portName: args.backendPortName,
      backends: [{ 
        group: args.backendInstanceGroup,
        balancingMode: 'UTILIZATION',
        maxUtilization: 0.8,
        capacityScaler: 1,
      }],
      healthChecks: (this.hcTcp?.selfLink ?? this.hcHttps!.selfLink),
      timeoutSec: 30,
      network: args.networkId,
      subnetwork: args.backendSubnetId,
    };
    this.backend = new gcp.compute.RegionBackendService(`${args.name}-${args.backendPortName}-int`, backendArgs, { 
      parent: this, 
      dependsOn: [this.hcTcp ?? this.hcHttps!],
      deleteBeforeReplace: true
    });

    const frArgs: any = {
      name: `${args.name}-${args.backendPortName}-int`,
      region: args.region,
      ipAddress: args.ipAddressSelfLink,
      loadBalancingScheme: 'INTERNAL',
      network: args.networkId,
      subnetwork: args.backendSubnetId,
      ports: [String(args.port)],
      backendService: this.backend.selfLink,
    };
    if (args.labels) frArgs.labels = args.labels;
    this.forwardingRule = new gcp.compute.ForwardingRule(`${args.name}-${args.backendPortName}-int`, frArgs, { 
      parent: this, 
      dependsOn: [this.backend] 
    });

    this.registerOutputs({
      backendServiceId: this.backend.id,
      forwardingRuleId: this.forwardingRule.id,
    });
  }
}

