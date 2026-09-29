/**
 * RunnerJobRerun — reruns a CI job whose runner was taken away with its node
 * (a reclaimed Spot instance, a drained or failed node), and no other.
 *
 * A job on a lost runner is not moved anywhere: GitHub and Gitea show it as in
 * progress until they give the runner up, mark it failed and leave it there.
 * This controller (`docker/devops-bridge/runner_rerun`) watches the runner
 * pods. When Kubernetes takes one away (the pod carries the DisruptionTarget
 * condition, or is deleted while running on a node that is gone or not ready)
 * it notes the job the runner held, and once that run has finished it asks
 * for the job to run again: the one job when one was lost, the run's failed
 * jobs when several were. It leaves a run alone that has already started
 * another attempt or reached `maxAttempts`, and it never touches a job whose
 * runner pod simply ended.
 *
 * It finds a runner's job in the EphemeralRunner status for Actions Runner
 * Controller scale sets, and by runner name among the jobs in progress for
 * {@link GiteaEphemeralRunners} pools. The tokens need read and write access
 * to Actions on the repositories; without one, that platform's lost jobs are
 * only logged. What is pending is kept in a ConfigMap the controller creates,
 * so a restart loses nothing.
 *
 * @example
 * ```typescript
 * new RunnerJobRerun(chart, "rerun", {
 *   image: "ghcr.io/example/devops-bridge@sha256:...",
 *   arcNamespaces: ["arc-runners"],
 *   githubToken: "ref+sops://.secrets/secrets.yaml#github/actions_rerun_token",
 *   gitea: {
 *     instanceUrl: "https://git.example.com",
 *     namespace: "gitea-runners",
 *     pools: { infra: "platform/infra" },
 *     token: "ref+sops://.secrets/secrets.yaml#gitea/actions_rerun_token",
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Size } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct } from "../../../core";

export interface RunnerJobRerunGitea {
  /** Gitea base URL, e.g. https://git.example.com. */
  instanceUrl: string;
  /** Namespace of the runner Jobs. */
  namespace: string;
  /** Repository (`owner/name`) by runner pool, as in {@link GiteaEphemeralRunners}. */
  pools: Record<string, string>;
  /** A token that may read and rerun the repositories' Actions jobs (a `ref+sops://` value). */
  token?: string;
}

export interface RunnerJobRerunConfig {
  /** Namespace (default "runner-rerun"), created by the module. */
  namespace?: string;
  /** The devops-bridge image, which carries the controller. */
  image: string;
  /** Namespaces of Actions Runner Controller runner pods. */
  arcNamespaces?: string[];
  /** A token that may read and rerun the repositories' Actions jobs on GitHub (a `ref+sops://` value). */
  githubToken?: string;
  gitea?: RunnerJobRerunGitea;
  /** The last attempt of a run the controller asks for (default 3). */
  maxAttempts?: number;
  /** Log the rerun instead of asking for it. */
  dryRun?: boolean;
  nodeSelector?: Record<string, string>;
}

const NAME = "runner-rerun";
const CONFIG_PATH = "/etc/runner-rerun";
export const STATE_CONFIGMAP = "runner-rerun-state";
const EPHEMERAL_RUNNERS = kplus.ApiResource.custom({ apiGroup: "actions.github.com", resourceType: "ephemeralrunners" });

/** The controller's config file. */
export function runnerRerunSettings(config: RunnerJobRerunConfig): Record<string, unknown> {
  return {
    maxAttempts: config.maxAttempts ?? 3,
    sources: [
      ...(config.arcNamespaces ?? []).map(namespace => ({ kind: "arc", namespace })),
      ...(config.gitea
        ? [{ kind: "gitea", namespace: config.gitea.namespace, instanceUrl: config.gitea.instanceUrl, pools: config.gitea.pools }]
        : []),
    ],
  };
}

export class RunnerJobRerun extends BaseConstruct<RunnerJobRerunConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly deployment: kplus.Deployment;

  constructor(scope: Construct, id: string, config: RunnerJobRerunConfig) {
    super(scope, id, config);
    const namespace = this.config.namespace ?? NAME;
    const settings = runnerRerunSettings(this.config);
    if (!(settings.sources as unknown[]).length) throw new Error("RunnerJobRerun: name arcNamespaces or gitea");
    this.namespace = new kplus.Namespace(this, "namespace", { metadata: { name: namespace } });

    const account = new kplus.ServiceAccount(this, "account", {
      metadata: { name: NAME, namespace },
      automountToken: true,
    });
    const state = new kplus.Role(this, "state", { metadata: { name: `${NAME}-state`, namespace } });
    state.allow(["get", "create", "update"], kplus.ApiResource.CONFIG_MAPS);
    state.bind(account);
    const nodes = new kplus.ClusterRole(this, "nodes", { metadata: { name: `${NAME}-nodes` } });
    nodes.allowGet(kplus.ApiResource.NODES);
    nodes.bind(account);
    const watched = new Map<string, boolean>();
    for (const arc of this.config.arcNamespaces ?? []) watched.set(arc, true);
    if (this.config.gitea) watched.set(this.config.gitea.namespace, watched.get(this.config.gitea.namespace) ?? false);
    for (const [runners, arc] of watched) {
      const role = new kplus.Role(this, `runners-${runners}`, { metadata: { name: NAME, namespace: runners } });
      role.allowRead(kplus.ApiResource.PODS, ...(arc ? [EPHEMERAL_RUNNERS] : []));
      role.bind(account);
    }

    const tokens: Record<string, string> = {
      ...(this.config.githubToken ? { GITHUB_TOKEN: this.config.githubToken } : {}),
      ...(this.config.gitea?.token ? { GITEA_TOKEN: this.config.gitea.token } : {}),
    };
    const secret = Object.keys(tokens).length
      ? new kplus.Secret(this, "tokens", { metadata: { name: `${NAME}-tokens`, namespace }, stringData: tokens })
      : undefined;
    const settingsMap = new kplus.ConfigMap(this, "settings", {
      metadata: { name: `${NAME}-settings`, namespace },
      data: { "config.json": JSON.stringify(settings) },
    });

    this.deployment = new kplus.Deployment(this, "deployment", {
      metadata: { name: NAME, namespace },
      replicas: 1,
      // One controller at a time: two would both ask for the rerun.
      strategy: kplus.DeploymentStrategy.recreate(),
      serviceAccount: account,
      automountServiceAccountToken: true,
      containers: [
        {
          name: NAME,
          image: this.config.image,
          imagePullPolicy: kplus.ImagePullPolicy.IF_NOT_PRESENT,
          command: ["python", "-u", "-m", "runner_rerun.main"],
          securityContext: { user: 10001, group: 10001 },
          envVariables: {
            RERUN_CONFIG: kplus.EnvValue.fromValue(`${CONFIG_PATH}/config.json`),
            STATE_CONFIGMAP: kplus.EnvValue.fromValue(STATE_CONFIGMAP),
            POD_NAMESPACE: kplus.EnvValue.fromFieldRef(kplus.EnvFieldPaths.POD_NAMESPACE),
            PYTHONDONTWRITEBYTECODE: kplus.EnvValue.fromValue("1"),
            ...(this.config.dryRun ? { DRY_RUN: kplus.EnvValue.fromValue("true") } : {}),
            ...Object.fromEntries(Object.keys(tokens).map(key => [key, kplus.EnvValue.fromSecretValue({ secret: secret!, key })])),
          },
          resources: {
            cpu: { request: kplus.Cpu.millis(20) },
            memory: { request: Size.mebibytes(96), limit: Size.mebibytes(256) },
          },
          volumeMounts: [{ path: CONFIG_PATH, volume: kplus.Volume.fromConfigMap(this, "settings-volume", settingsMap), readOnly: true }],
        },
      ],
    });
    if (this.config.nodeSelector) {
      for (const [key, value] of Object.entries(this.config.nodeSelector)) {
        this.deployment.scheduling.attract(kplus.Node.labeled(kplus.NodeLabelQuery.is(key, value)));
      }
    }
  }
}

export default RunnerJobRerun;
