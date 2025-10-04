import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface PublicLbConfig {
  name: string;
  backendPortName: string; // e.g., kubernetes, bootstrapper, verify, etc.
  port: number;
  healthCheck: 'TCP' | 'HTTPS';
  backendInstanceGroups: pulumi.Input<string>[];
  ipAddress: pulumi.Input<string>;
  region: pulumi.Input<string>;
  labels?: Record<string, string>;
}

export class PublicLoadBalancer extends pulumi.ComponentResource {
  public readonly backend: gcp.compute.RegionBackendService;
  public readonly hcTcp?: gcp.compute.RegionHealthCheck;
  public readonly hcHttps?: gcp.compute.RegionHealthCheck;
  public readonly forwardingRule: gcp.compute.ForwardingRule;

  constructor(name: string, args: PublicLbConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:PublicLoadBalancer', name, args, opts);

    const hcName = `${args.name}-${args.backendPortName}-hc`;
    if (args.healthCheck === 'TCP') {
      this.hcTcp = new gcp.compute.RegionHealthCheck(hcName, {
        name: hcName,
        region: args.region,
        tcpHealthCheck: { port: args.port },
        checkIntervalSec: 5,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      }, { parent: this });
    } else {
      this.hcHttps = new gcp.compute.RegionHealthCheck(hcName, {
        name: hcName,
        region: args.region,
        httpsHealthCheck: { port: args.port },
        checkIntervalSec: 5,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      }, { parent: this });
    }

    const backendArgs: any = {
      name: `${args.name}-${args.backendPortName}`,
      region: args.region,
      protocol: 'TCP',
      loadBalancingScheme: 'EXTERNAL',
      backends: args.backendInstanceGroups.map((ig) => ({ group: ig, balancingMode: 'CONNECTION' })),
      healthChecks: (this.hcTcp?.selfLink ?? this.hcHttps!.selfLink),
      timeoutSec: 30,
    };
    this.backend = new gcp.compute.RegionBackendService(`${args.name}-${args.backendPortName}`, backendArgs, { parent: this, dependsOn: [this.hcTcp ?? this.hcHttps!] });

    const frArgs: any = {
      name: `${args.name}-${args.backendPortName}`,
      ipAddress: args.ipAddress,
      region: args.region,
      loadBalancingScheme: 'EXTERNAL',
      ipProtocol: 'TCP',
      ports: [String(args.port)],
      backendService: this.backend.selfLink,
    };
    if (args.labels) frArgs.labels = args.labels as any;
    this.forwardingRule = new gcp.compute.ForwardingRule(`${args.name}-${args.backendPortName}`, frArgs, { parent: this, dependsOn: [this.backend] });

    this.registerOutputs({});
  }
}


