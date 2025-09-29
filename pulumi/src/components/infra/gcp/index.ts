import * as pulumi from '@pulumi/pulumi';
import { Gke } from './gke';
import type { GkeConfig } from './gke';
import { Network } from './network';
import type { NetworkConfig } from './network';
import { Iam } from './iam';
import type { IamConfig } from './iam';

function stableShortHash(input: string): string {
  // Simple deterministic 32-bit FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  // 8 hex chars
  return ('0000000' + hash.toString(16)).slice(-8);
}

export type GcpConfig = {
  network: NetworkConfig;
  gke: GkeConfig;
  iam?: IamConfig;
};

export interface GcpOutput {
  networkId?: any;
  subnetworkId?: any;
  networkSelfLink?: any;
  subnetworkSelfLink?: any;
  podsRangeName?: string;
  servicesRangeName?: string;
  gkeClusterName?: any;
  kubeconfig?: any;
  externalDnsGsaEmail?: any;
  certManagerGsaEmail?: any;
}

export class Gcp  extends pulumi.ComponentResource{
  public readonly network: Network;
  public readonly gke: Gke;
  public readonly iam?: Iam;
  constructor(name: string, args: GcpConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:gcp', name, args, opts);

    const pods = args.network?.podsSecondaryCidr || '';
    const svcs = args.network?.servicesSecondaryCidr || '';
    const suffix = stableShortHash(`${pods}|${svcs}`);
    const baseName = `${name}-${suffix}`;
    // Use a suffix tied to secondary ranges so CIDR edits create new resources
    this.network = new Network(baseName, args.network, { parent: this });
    this.gke = new Gke(baseName, { ...args.gke, network: this.network }, { parent: this });
    // Use non-suffixed name for IAM to keep GSA accountIds human-readable
    if (args.iam) this.iam = new Iam(name, args.iam);
    
    this.registerOutputs({
      networkId: this.network?.network?.id,
      subnetworkId: this.network?.subnetwork?.id,
      networkSelfLink: this.network?.network?.selfLink,
      subnetworkSelfLink: this.network?.subnetwork?.selfLink,
      podsRangeName: this.network?.podsRangeName,
      servicesRangeName: this.network?.servicesRangeName,
      gkeClusterName: this.gke?.cluster?.name,
      kubeconfig: this.gke?.kubeconfig,
      externalDnsGsaEmail: this.iam?.externalDnsGsaEmail,
      certManagerGsaEmail: this.iam?.certManagerGsaEmail,
    });
  }
}