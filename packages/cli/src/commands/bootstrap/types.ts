/** Options for `nebula bootstrap` (shared across providers). */
export interface BootstrapOptions {
  /** Kind (bootstrap) cluster name */
  name?: string;
  /** Cloud provider for the management cluster ('gcp' | 'aws', default 'gcp') */
  provider?: string;
  /** Skip Kind cluster creation */
  skipKind?: boolean;
  /** Skip credentials setup */
  skipCredentials?: boolean;

  // --- gcp ---
  /** GCP project ID (gcp) */
  project?: string;
  /** Path to a GCP credentials JSON file (gcp) */
  credentials?: string;
  /** Skip the GKE deployment, Kind only (gcp) */
  skipGke?: boolean;

  // --- aws ---
  /** AWS region (aws) */
  region?: string;
  /** AWS named profile to resolve credentials from (aws) */
  awsProfile?: string;
  /** AMI id for the management cluster nodes (aws; recommend Ubuntu 22.04) */
  amiId?: string;
}

/** A cloud provider's bootstrap implementation. */
export interface BootstrapProvider {
  /** Provider key used by `--provider` */
  name: string;
  /** Run the full bootstrap for this provider. */
  bootstrap(options: BootstrapOptions): Promise<void>;
}
