/**
 * Gcp - GCP Infrastructure module (VPC, GKE).
 * 
 * GCP provider is auto-injected from config (gcpProject, gcpRegion).
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * import { Gcp } from 'nebula/modules/infra/gcp';
 * 
 * setConfig({
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 * });
 * 
 * new Gcp('my-infra', {
 *   network: { cidr: '10.10.0.0/16' },
 *   gke: { name: 'my-cluster', location: 'us-central1-a' },
 * });
 * ```
 */
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { BaseModule } from '../../../core/base-module';
import { getConfig } from '../../../core/config';
import { Gke } from './gke';
import type { GkeConfig } from './gke';
import { Network } from './network';
import type { NetworkConfig } from './network';
import { Iam } from './iam';
import type { IamConfig } from './iam';

function stableShortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

export type GcpConfig = {
  network: NetworkConfig;
  /** GKE cluster config (project is injected automatically from provider) */
  gke: Omit<GkeConfig, 'project' | 'network'>;
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

export class Gcp extends BaseModule {
  public readonly network: Network;
  public readonly gke: Gke;
  public readonly iam?: Iam;
  public readonly outputs: GcpOutput;
  public readonly project: pulumi.Output<string>;
  
  constructor(name: string, args: GcpConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:Gcp', name, args as unknown as Record<string, unknown>, opts, { needsGcp: true });

    const nebulaConfig = getConfig();
    const gcpProvider = this.getProvider('gcp:project:Project') as gcp.Provider | undefined;
    
    // Get project from provider or config
    if (gcpProvider?.project) {
      this.project = gcpProvider.project.apply(p => {
        if (!p) throw new Error('GCP provider project is not set');
        return p;
      });
    } else if (nebulaConfig?.gcpProject) {
      this.project = pulumi.output(nebulaConfig.gcpProject);
    } else {
      throw new Error('GCP project not found. Set gcpProject in config or pass a GCP provider.');
    }

    const pods = args.network?.podsSecondaryCidr || '';
    const svcs = args.network?.servicesSecondaryCidr || '';
    const suffix = stableShortHash(`${pods}|${svcs}`);
    const baseName = `${name}-${suffix}`;

    this.network = new Network(baseName, args.network, { parent: this });
    this.gke = new Gke(baseName, { ...args.gke, project: this.project, network: this.network }, { parent: this });
    
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
