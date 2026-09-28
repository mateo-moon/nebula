/**
 * GiteaEphemeralRunners — Gitea Actions runners that exist only while a job
 * is queued, scaled by KEDA.
 *
 * Gitea has no runner controller, so this composes upstream parts: one KEDA
 * `ScaledJob` per runner pool polls the repository's queued jobs
 * (`GET /api/v1/repos/{owner}/{repo}/actions/jobs?status=queued`) and
 * creates one Kubernetes Job per queued job. Each Job runs `act_runner`
 * (the docker-in-docker rootless image) registered as EPHEMERAL: it takes
 * exactly one job, exits, and Gitea deletes the registration itself. When
 * nothing is queued there are no Jobs, and a cluster autoscaler can take the
 * nodes away too; a Job's pod refuses eviction while it runs.
 *
 * The runner's docker store is an emptyDir mounted at the image's own volume
 * path (containerd drops the image volume only on an exact match), with an
 * ephemeral-storage request and limit, and its data root is a subdirectory,
 * because the rootless daemon cannot chmod the root-owned emptyDir itself.
 * Every Job starts with an empty store, so its base image is pulled each time:
 * `registryMirrors` points the daemon at a pull-through cache for that. The
 * image's other volumes (`/data` with the registration file, `/var/lib/docker`,
 * unused by rootless) stay anonymous and kilobyte-sized.
 *
 * Needs a Gitea API token that can list the repository's jobs (a
 * TriggerAuthentication) and, per pool, the repository's runner
 * registration token; both are usually `ref+sops://` values.
 *
 * @example
 * ```typescript
 * new GiteaEphemeralRunners(chart, "runners", {
 *   namespace: "gitea-runners",
 *   instanceUrl: "https://git.example.com",
 *   apiToken: "ref+sops://.secrets/secrets.yaml#gitea/api_token",
 *   pools: {
 *     infra: {
 *       repository: "platform/infra",
 *       registrationToken: "ref+sops://.secrets/secrets.yaml#gitea/registration_token_infra",
 *       labels: "self-hosted:docker://catthehacker/ubuntu:act-22.04",
 *       maxJobs: 6,
 *       nodeSelector: { "pool": "ci" },
 *       tolerations: [{ key: "ci", operator: "Equal", value: "true", effect: "NoSchedule" }],
 *     },
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct, type Toleration } from "../../../core";
import {
  ScaledJob,
  ScaledJobSpecJobTargetRefTemplateSpecContainersResourcesLimits as Limit,
  ScaledJobSpecJobTargetRefTemplateSpecContainersResourcesRequests as Request,
  ScaledJobSpecScalingStrategyStrategy,
  TriggerAuthentication,
  type ScaledJobSpec,
} from "#imports/keda.sh";

const quantities = <T>(from: (v: string) => T, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, from(v)]));

export interface EphemeralStorage {
  request: string;
  limit?: string;
}

export interface GiteaRunnerPool {
  /** `owner/name` of the repository the runners register with. */
  repository: string;
  /** The repository's runner registration token (a `ref+sops://` value). */
  registrationToken: string;
  /** act_runner labels, e.g. `self-hosted:docker://catthehacker/ubuntu:act-22.04,size-l:docker://...`. */
  labels: string;
  /** Most Jobs at once (default 4). */
  maxJobs?: number;
  /** act_runner config.yaml contents, when the defaults will not do. */
  runnerConfig?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  /** CPU and memory of the runner container (defaults: requests 1/2Gi, limits 6/12Gi). */
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  /** Disk of the runner's docker store (default request 10Gi, limit 25Gi). */
  storage?: EphemeralStorage;
  /** A Job older than this is killed (default 3 hours). */
  jobDeadlineSeconds?: number;
}

export interface GiteaEphemeralRunnersConfig {
  /** Namespace the Jobs, secrets and scalers live in, created by the construct. */
  namespace: string;
  /** Gitea base URL, e.g. https://git.example.com. */
  instanceUrl: string;
  /** A Gitea API token that can read the repositories' Actions jobs (a `ref+sops://` value). */
  apiToken: string;
  /** act_runner image (default the 0.6.1 docker-in-docker rootless image). */
  runnerImage?: string;
  /** How often KEDA polls the queue, in seconds (default 10). */
  pollingInterval?: number;
  /** Pull-through caches the runners' docker daemon pulls docker.io images from (a {@link RegistryMirror} endpoint). */
  registryMirrors?: string[];
  /** Runner pools by name; the name is the ScaledJob's. */
  pools: Record<string, GiteaRunnerPool>;
}

export const DEFAULT_RUNNER_IMAGE = "gitea/act_runner:0.6.1-dind-rootless";
/** The image's VOLUME for the rootless docker store. */
export const DOCKER_VOLUME = "/home/rootless/.local/share/docker";
const DEFAULT_STORAGE: Required<EphemeralStorage> = { request: "10Gi", limit: "25Gi" };
const DEFAULT_RESOURCES = { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "6", memory: "12Gi" } };
const SAFE_TO_EVICT = "cluster-autoscaler.kubernetes.io/safe-to-evict";

/** The queued-jobs URL a pool's trigger polls. */
export function queuedJobsUrl(instanceUrl: string, repository: string): string {
  return `${instanceUrl.replace(/\/$/, "")}/api/v1/repos/${repository}/actions/jobs?status=queued&limit=1`;
}

export interface ScaledJobNames {
  /** The TriggerAuthentication carrying the API token. */
  authentication: string;
  /** The Secret with the pool's registration token (key `token`). */
  registrationSecret: string;
  /** The ConfigMap with the daemon's config and, optionally, act_runner's (keys `daemon.json`, `config.yaml`). */
  config: string;
}

/** The ScaledJob spec of one pool. */
export function scaledJobSpec(
  name: string,
  pool: GiteaRunnerPool,
  config: Pick<GiteaEphemeralRunnersConfig, "instanceUrl" | "runnerImage" | "pollingInterval">,
  names: ScaledJobNames,
): ScaledJobSpec {
  const storage = pool.storage ?? DEFAULT_STORAGE;
  const resources = pool.resources ?? DEFAULT_RESOURCES;
  return {
    pollingInterval: config.pollingInterval ?? 10,
    minReplicaCount: 0,
    maxReplicaCount: pool.maxJobs ?? 4,
    successfulJobsHistoryLimit: 3,
    failedJobsHistoryLimit: 5,
    // One Job per queued job, minus the Jobs already running.
    scalingStrategy: { strategy: ScaledJobSpecScalingStrategyStrategy.DEFAULT },
    triggers: [
      {
        type: "metrics-api",
        metadata: {
          url: queuedJobsUrl(config.instanceUrl, pool.repository),
          valueLocation: "total_count",
          targetValue: "1",
          activationTargetValue: "0",
          format: "json",
          authMode: "apiKey",
          method: "header",
          keyParamName: "Authorization",
        },
        authenticationRef: { name: names.authentication },
      },
    ],
    jobTargetRef: {
      // An ephemeral runner takes one job and exits; a failed pod is not retried, the queue re-scales instead.
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: pool.jobDeadlineSeconds ?? 3 * 3600,
      template: {
        metadata: {
          labels: { "gitea-runner/pool": name },
          annotations: { [SAFE_TO_EVICT]: "false" },
        },
        spec: {
          restartPolicy: "Never",
          ...(pool.nodeSelector ? { nodeSelector: pool.nodeSelector } : {}),
          ...(pool.tolerations ? { tolerations: pool.tolerations } : {}),
          securityContext: { fsGroup: 1000 },
          containers: [
            {
              name: "runner",
              image: config.runnerImage ?? DEFAULT_RUNNER_IMAGE,
              imagePullPolicy: "IfNotPresent",
              // Rootless dockerd runs inside the container.
              securityContext: { privileged: true },
              env: [
                { name: "DOCKER_HOST", value: "unix:///run/user/1000/docker.sock" },
                { name: "GITEA_INSTANCE_URL", value: config.instanceUrl },
                { name: "GITEA_RUNNER_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
                {
                  name: "GITEA_RUNNER_REGISTRATION_TOKEN",
                  valueFrom: { secretKeyRef: { name: names.registrationSecret, key: "token" } },
                },
                { name: "GITEA_RUNNER_LABELS", value: pool.labels },
                // register --ephemeral: Gitea deletes the runner after its job; daemon --once: the process ends with it.
                { name: "GITEA_RUNNER_EPHEMERAL", value: "1" },
                { name: "GITEA_RUNNER_ONCE", value: "1" },
                ...(pool.runnerConfig ? [{ name: "CONFIG_FILE", value: "/etc/act_runner/config.yaml" }] : []),
              ],
              volumeMounts: [
                { name: "docker", mountPath: DOCKER_VOLUME },
                { name: "dockerd-config", mountPath: "/home/rootless/.config/docker", readOnly: true },
                ...(pool.runnerConfig ? [{ name: "runner-config", mountPath: "/etc/act_runner", readOnly: true }] : []),
              ],
              resources: {
                requests: quantities(Request.fromString, { ...(resources.requests ?? {}), "ephemeral-storage": storage.request }),
                limits: quantities(Limit.fromString, { ...(resources.limits ?? {}), ...(storage.limit ? { "ephemeral-storage": storage.limit } : {}) }),
              },
            },
          ],
          volumes: [
            { name: "docker", emptyDir: {} },
            { name: "dockerd-config", configMap: { name: names.config, items: [{ key: "daemon.json", path: "daemon.json" }] } },
            ...(pool.runnerConfig
              ? [{ name: "runner-config", configMap: { name: names.config, items: [{ key: "config.yaml", path: "config.yaml" }] } }]
              : []),
          ],
        },
      },
    },
  };
}

export class GiteaEphemeralRunners extends BaseConstruct<GiteaEphemeralRunnersConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly scaledJobs: Record<string, ScaledJob> = {};

  constructor(scope: Construct, id: string, config: GiteaEphemeralRunnersConfig) {
    super(scope, id, config);
    const namespace = this.config.namespace;
    this.namespace = new kplus.Namespace(this, "namespace", { metadata: { name: namespace } });

    // The API token, as the Authorization header value the metrics-api scaler sends.
    const apiSecret = new kplus.Secret(this, "api-token", {
      metadata: { name: `${id}-gitea-api`, namespace },
      stringData: { authorization: `token ${this.config.apiToken}` },
    });
    const authentication = new TriggerAuthentication(this, "authentication", {
      metadata: { name: `${id}-gitea-api`, namespace },
      spec: { secretTargetRef: [{ parameter: "apiKey", name: apiSecret.name, key: "authorization" }] },
    });

    for (const [name, pool] of Object.entries(this.config.pools)) {
      const registration = new kplus.Secret(this, `${name}-registration`, {
        metadata: { name: `${name}-registration`, namespace },
        stringData: { token: pool.registrationToken },
      });
      const configMap = new kplus.ConfigMap(this, `${name}-config`, {
        metadata: { name: `${name}-config`, namespace },
        data: {
          // data-root is a subdirectory: the rootless daemon chmods its data root, which fails on the emptyDir itself.
          "daemon.json": JSON.stringify({
            "data-root": `${DOCKER_VOLUME}/data`,
            ...(this.config.registryMirrors?.length ? { "registry-mirrors": this.config.registryMirrors } : {}),
          }),
          ...(pool.runnerConfig ? { "config.yaml": pool.runnerConfig } : {}),
        },
      });
      this.scaledJobs[name] = new ScaledJob(this, `${name}-scaled-job`, {
        metadata: { name, namespace },
        spec: scaledJobSpec(name, pool, this.config, {
          authentication: authentication.name,
          registrationSecret: registration.name,
          config: configMap.name,
        }),
      });
    }
  }
}

export default GiteaEphemeralRunners;
