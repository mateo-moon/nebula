import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { defineModule } from '../../../core/module';
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
  networkId?: pulumi.Output<string>;
  subnetworkId?: pulumi.Output<string>;
  networkSelfLink?: pulumi.Output<string>;
  subnetworkSelfLink?: pulumi.Output<string>;
  podsRangeName?: string,
  servicesRangeName?: string,
  gkeClusterName?: pulumi.Output<string>;
  gkeClusterEndpoint?: pulumi.Output<string>;
  gkeLocation?: pulumi.Output<string>;
  kubeconfig?: pulumi.Output<string>;
  externalDnsGsaEmail?: pulumi.Output<string> | undefined;
  certManagerGsaEmail?: pulumi.Output<string> | undefined;
}

export class Gcp  extends pulumi.ComponentResource{
  public readonly network: Network;
  public readonly gke: Gke;
  public readonly iam?: Iam;
  public readonly outputs: GcpOutput;
  public readonly project: pulumi.Output<string>;
  
  constructor(name: string, args: GcpConfig, opts?: pulumi.ComponentResourceOptions) {
    super('gcp', name, args, opts);

    // Get GCP provider from inherited __providers via Pulumi's public API
    const gcpProvider = this.getProvider('gcp:project:Project') as gcp.Provider | undefined;
    
    if (!gcpProvider) {
      throw new Error('GCP provider not found in parent chain. Make sure to pass a GCP provider to the parent Component and ensure opts.parent is set.');
    }
    this.project = gcpProvider.project.apply(p => {
      if (!p) throw new Error('GCP provider project is not set');
      return p;
    });

    const pods = args.network?.podsSecondaryCidr || '';
    const svcs = args.network?.servicesSecondaryCidr || '';
    const suffix = stableShortHash(`${pods}|${svcs}`);
    const baseName = `${name}-${suffix}`;
    // Use a suffix tied to secondary ranges so CIDR edits create new resources
    this.network = new Network(baseName, args.network, { parent: this });
    this.gke = new Gke(baseName, { ...args.gke, project: this.project, network: this.network }, { parent: this });
    // Use non-suffixed name for IAM to keep GSA accountIds human-readable
    if (args.iam) this.iam = new Iam(name, args.iam);
    
    this.outputs = {
      networkId: this.network.network.id,
      subnetworkId: this.network.subnetwork.id,
      networkSelfLink: this.network.network.selfLink,
      subnetworkSelfLink: this.network.subnetwork.selfLink,
      podsRangeName: this.network.podsRangeName,
      servicesRangeName: this.network.servicesRangeName,
      gkeClusterName: this.gke.cluster.name,
      gkeClusterEndpoint: this.gke.cluster.endpoint,
      gkeLocation: this.gke.cluster.location,
      kubeconfig: this.gke.kubeconfig,
      externalDnsGsaEmail: this.iam?.externalDnsGsaEmail,
      certManagerGsaEmail: this.iam?.certManagerGsaEmail,
    };
    this.registerOutputs(this.outputs);
  }
}
/**
 * GCP infrastructure module with dependency metadata.
 * 
 * Provides:
 * - `gcp-network`: VPC network and subnets
 * - `gcp-gke`: Google Kubernetes Engine cluster
 */
export default defineModule(
  {
    name: 'gcp',
    provides: ['gcp-network', 'gcp-gke'],
  },
  (args: GcpConfig, opts) => new Gcp('gcp', args, opts)
);