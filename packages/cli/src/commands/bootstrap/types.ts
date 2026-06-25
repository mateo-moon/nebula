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
  /** AWS named profile to resolve credentials from (aws; else default cred chain/env). */
  awsProfile?: string;
  /**
   * Path to the `aws/` repo subtree — the single source of truth (aws; default cwd).
   * Its `config.ts` (region, cluster name, AMI, replicas, …) and cdk8s modules under
   * `infra/*` + `apps/*` are what both the bootstrap and ArgoCD use. The thin bootstrap
   * brings up Kind + the mgmt cluster + ArgoCD; ArgoCD reconciles everything else from
   * this tree. Scaffold one with `nebula init --provider aws`.
   */
  gitopsDir?: string;
}

/** A cloud provider's bootstrap implementation. */
export interface BootstrapProvider {
  /** Provider key used by `--provider` */
  name: string;
  /** Run the full bootstrap for this provider. */
  bootstrap(options: BootstrapOptions): Promise<void>;
}
