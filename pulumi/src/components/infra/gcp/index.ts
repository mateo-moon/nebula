import { Gke, GkeConfig } from './gke';
import { Network, NetworkConfig } from './network';

export type GcpConfig = {
  network: NetworkConfig;
  gke: GkeConfig;
};

export class Gcp {
  public readonly network: Network;
  public readonly gke: Gke;
  constructor(name: string, config: GcpConfig) {
    this.network = new Network(name, config.network);
    this.gke = new Gke(name, this.network, config.gke);
  }
}