import * as pulumi from '@pulumi/pulumi';
import { Aws } from './aws';
import { Gcp } from './gcp';
import { Dns } from './dns';
import { Constellation } from './constellation';
import type { AwsConfig, AwsOutput } from './aws';
import type { GcpConfig, GcpOutput } from './gcp';
import type { DnsConfig, DnsOutput } from './dns';
import type { ConstellationConfig, ConstellationOutput } from './constellation';

export interface InfraConfig {
  awsConfig?: AwsConfig;
  gcpConfig?: GcpConfig;
  constellationConfig?: ConstellationConfig;
  dnsConfig?: DnsConfig;
  deploy?: boolean;
  dependsOn?: string[];
}

export interface InfraOutput {
  aws?: AwsOutput;
  gcp?: GcpOutput;
  dns?: DnsOutput;
  constellation?: ConstellationOutput;
}
export class Infra extends pulumi.ComponentResource {
  public readonly aws?: Aws;
  public readonly gcp?: Gcp;
  public readonly dns?: Dns;
  public readonly constellation?: Constellation;
  public readonly outputs: InfraOutput;

  constructor(
    name: string,
    args?: InfraConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('infra', name, args, opts);

    if (args && args.awsConfig) this.aws = new Aws(name, args.awsConfig);
    if (args && args.gcpConfig) this.gcp = new Gcp(name, args.gcpConfig);
    if (args && args.dnsConfig) this.dns = new Dns(name, args.dnsConfig);
    if (args && args.constellationConfig) this.constellation = new Constellation(name, args.constellationConfig);

    // Collect outputs from all sub-components
    this.outputs = {
      ...(this.aws && { aws: this.aws.outputs }),
      ...(this.gcp && { gcp: this.gcp.outputs }),
      ...(this.dns && { dns: this.dns.outputs }),
      ...(this.constellation && { constellation: this.constellation.outputs }),
    };

    // Register outputs for cross-stack references
    this.registerOutputs(this.outputs);
  }
}
