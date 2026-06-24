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
  /**
   * Management cluster name (aws; default 'mgmt'). Drives the CAPI cluster name,
   * AWS resource tags, and the node IAM names — set a distinct value to run
   * isolated from another cluster in the same account.
   */
  clusterName?: string;
  /** Number of control-plane nodes (aws; default 3). Use 1 for a quick/test cluster. */
  cpReplicas?: number;
  /**
   * Opt-in GitOps handoff (aws): path to a checked-out repo subtree with
   * `meta/argocd` + `meta/argocd-apps` modules (e.g. `.../DevOps/aws`). When set,
   * the bootstrap installs ArgoCD on the management cluster and syncs the
   * app-of-apps so ArgoCD reconciles the platform from git thereafter.
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
