/**
 * ActionsRunnerController — GitHub's Actions Runner Controller (ARC) with
 * one or more runner scale sets: self-hosted GitHub Actions runners that the
 * controller starts per queued job and removes when the job ends.
 *
 * Two OCI charts from `oci://ghcr.io/actions/actions-runner-controller-charts`:
 * `gha-runner-scale-set-controller` (the operator and its CRDs) and one
 * `gha-runner-scale-set` per scale set (an `AutoscalingRunnerSet` bound to a
 * repository, organisation or enterprise URL). A scale set with `minRunners: 0`
 * holds no pod while nothing is queued, so a pool of Spot nodes under a cluster
 * autoscaler costs nothing between jobs.
 *
 * Every scale set defaults to dind: the runner pod carries a privileged
 * `docker:dind` sidecar (a native sidecar, so Kubernetes 1.29 or newer), which
 * workflows that build or run containers need. The module renders that pod
 * template itself rather than through the chart's `containerMode: dind`,
 * because the chart's own dind sidecar leaves `/var/lib/docker` on the image's
 * anonymous volume, which the kubelet neither counts nor bounds: here the
 * daemon's store is an emptyDir mounted at exactly that path, with an
 * ephemeral-storage request and limit, and the runner's workspace is
 * requested too, so disk pressure evicts the pod that fills the disk. Pin the
 * runner pods to a node pool with `nodeSelector` and `tolerations`, and size
 * the runner container with `resources`.
 *
 * The chart discovers the controller with a `lookup`, which `helm template`
 * cannot do, so this module names the controller's service account explicitly
 * on both sides.
 *
 * This module extends `BaseConstruct` (not `HelmModule`) because the charts
 * are OCI references — the same pattern as `confidential-containers` and
 * `kagent`.
 *
 * @example
 * ```typescript
 * new ActionsRunnerController(chart, "arc", {
 *   scaleSets: {
 *     "ci-amd64": {
 *       githubConfigUrl: "https://github.com/my-org",
 *       auth: { token: "ref+sops://.secrets/secrets.yaml#github/runner_pat" },
 *       maxRunners: 4,
 *       nodeSelector: { "kubernetes.io/arch": "amd64" },
 *       resources: { requests: { cpu: "2", memory: "4Gi" } },
 *     },
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct, syncWave, type Toleration } from "../../../core";

/** Container mode of a runner pod, as the `gha-runner-scale-set` chart names it. */
export type RunnerContainerMode = "dind" | "kubernetes" | "kubernetes-novolume";

/**
 * How a scale set authenticates to GitHub. A pre-created Secret in the runners
 * namespace (keys `github_token`, or `github_app_id` / `github_app_installation_id` /
 * `github_app_private_key`), a personal access token, or a GitHub App.
 */
export type RunnerScaleSetAuth =
  | { secretName: string }
  | { token: string }
  | { appId: string; installationId: string; privateKey: string };

/** Work volume of a `kubernetes`-mode runner (one claim per runner pod). */
export interface RunnerWorkVolumeClaim {
  storageClassName: string;
  /** Requested size, e.g. "10Gi". */
  storage: string;
  /** Default ["ReadWriteOnce"]. */
  accessModes?: string[];
}

export interface RunnerResources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

/** An ephemeral-storage request, and optionally the limit that evicts the pod. */
export interface EphemeralStorage {
  request: string;
  limit?: string;
}

/**
 * Disk of a dind runner pod: the docker daemon's store (images, layers, build
 * cache) and the runner's workspace (checkouts, build output). Both are
 * emptyDirs the kubelet counts against these figures.
 */
export interface RunnerStorage {
  /** Default request 8Gi, limit 30Gi. */
  docker?: EphemeralStorage;
  /** Default request 5Gi, limit 20Gi. */
  workspace?: EphemeralStorage;
}

export interface RunnerScaleSetConfig {
  /** `https://github.com/<org>`, `https://github.com/<org>/<repo>` or an enterprise URL. */
  githubConfigUrl: string;
  auth: RunnerScaleSetAuth;
  /** Idle runners kept ready (default 0: nothing runs between jobs). */
  minRunners?: number;
  /** Runners at once (default 4). */
  maxRunners?: number;
  /** Runner group the scale set registers in (default: the chart's, "Default"). */
  runnerGroup?: string;
  /** Default "dind". */
  containerMode?: RunnerContainerMode;
  /** Required for `containerMode: "kubernetes"`. */
  workVolumeClaim?: RunnerWorkVolumeClaim;
  /** Runner image (default: the chart's `ghcr.io/actions/actions-runner:latest`). */
  runnerImage?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  /** CPU and memory of the runner container. */
  resources?: RunnerResources;
  /** Disk of a dind runner pod; ignored in the kubernetes modes. */
  storage?: RunnerStorage;
  /**
   * Annotations on the runner pods. By default they carry
   * `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`, so a cluster
   * autoscaler never removes a node under a running job; set it to "true"
   * here to allow that.
   */
  podAnnotations?: Record<string, string>;
  /** Extra chart values, deep-merged last. */
  values?: Record<string, unknown>;
}

export interface ActionsRunnerControllerConfig {
  /** Controller namespace (default "arc-systems"). */
  namespace?: string;
  /** Namespace of every scale set and its runner pods (default "arc-runners"). */
  runnersNamespace?: string;
  /** Chart version of both charts (default "0.14.2"). */
  version?: string;
  /** Helm release name of the controller (default "arc"); scale sets are released under their own name. */
  releaseName?: string;
  /** Extra values for the controller chart, deep-merged last. */
  controllerValues?: Record<string, unknown>;
  /** Scale sets by name; the name is the runner scale set's name on GitHub (`runs-on: <name>`). */
  scaleSets: Record<string, RunnerScaleSetConfig>;
  /** Local chart directories in place of the OCI references (an air-gapped or vendored render). */
  localChartPaths?: { controller?: string; scaleSet?: string };
}

export const ARC_CHART_REGISTRY = "oci://ghcr.io/actions/actions-runner-controller-charts";
/** A node with a running job is not the autoscaler's to remove. */
export const RUNNER_POD_ANNOTATIONS: Record<string, string> = {
  "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
};
export const ARC_DEFAULT_VERSION = "0.14.2";
const DEFAULT_NAMESPACE = "arc-systems";
const DEFAULT_RUNNERS_NAMESPACE = "arc-runners";
const DEFAULT_RELEASE = "arc";
/** The scale sets sync after the controller and its CRDs are healthy. */
const SCALE_SET_WAVE = 1;

const DIND_IMAGE = "docker:dind";
const DOCKER_STORE = "/var/lib/docker";
const DEFAULT_STORAGE: Required<RunnerStorage> = {
  docker: { request: "8Gi", limit: "30Gi" },
  workspace: { request: "5Gi", limit: "20Gi" },
};

const ephemeral = (storage: EphemeralStorage) => ({
  requests: { "ephemeral-storage": storage.request },
  ...(storage.limit ? { limits: { "ephemeral-storage": storage.limit } } : {}),
});

/**
 * The dind pod template the chart would render for `containerMode: dind`,
 * with the docker store on a counted, bounded emptyDir and the workspace
 * requested. The runner container keeps the caller's image and resources.
 */
export function dindTemplateSpec(set: RunnerScaleSetConfig, runner: Record<string, unknown>): Record<string, unknown> {
  const docker = set.storage?.docker ?? DEFAULT_STORAGE.docker;
  const workspace = set.storage?.workspace ?? DEFAULT_STORAGE.workspace;
  const resources = set.resources ?? {};
  const workspaceResources = ephemeral(workspace);
  return {
    ...(set.nodeSelector ? { nodeSelector: set.nodeSelector } : {}),
    ...(set.tolerations ? { tolerations: set.tolerations } : {}),
    initContainers: [
      {
        name: "init-dind-externals",
        image: runner.image,
        command: ["cp"],
        args: ["-r", "/home/runner/externals/.", "/home/runner/tmpDir/"],
        volumeMounts: [{ name: "dind-externals", mountPath: "/home/runner/tmpDir" }],
      },
      {
        name: "dind",
        image: DIND_IMAGE,
        args: ["dockerd", "--host=unix:///var/run/docker.sock", "--group=$(DOCKER_GROUP_GID)"],
        env: [{ name: "DOCKER_GROUP_GID", value: "123" }],
        securityContext: { privileged: true },
        restartPolicy: "Always",
        startupProbe: { exec: { command: ["docker", "info"] }, initialDelaySeconds: 0, failureThreshold: 24, periodSeconds: 5 },
        resources: ephemeral(docker),
        volumeMounts: [
          { name: "work", mountPath: "/home/runner/_work" },
          { name: "dind-sock", mountPath: "/var/run" },
          { name: "dind-externals", mountPath: "/home/runner/externals" },
          { name: "dind-store", mountPath: DOCKER_STORE },
        ],
      },
    ],
    containers: [
      {
        ...runner,
        env: [
          { name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" },
          { name: "RUNNER_WAIT_FOR_DOCKER_IN_SECONDS", value: "120" },
        ],
        volumeMounts: [
          { name: "work", mountPath: "/home/runner/_work" },
          { name: "dind-sock", mountPath: "/var/run" },
        ],
        resources: {
          requests: { ...(resources.requests ?? {}), ...workspaceResources.requests },
          ...(resources.limits || workspaceResources.limits
            ? { limits: { ...(resources.limits ?? {}), ...(workspaceResources.limits ?? {}) } }
            : {}),
        },
      },
    ],
    volumes: [
      { name: "work", emptyDir: {} },
      { name: "dind-sock", emptyDir: {} },
      { name: "dind-externals", emptyDir: {} },
      { name: "dind-store", emptyDir: {} },
    ],
  };
}

/** The controller's service account, named on both charts so `helm template` needs no cluster lookup. */
export function controllerServiceAccountName(releaseName = DEFAULT_RELEASE): string {
  return `${releaseName}-gha-rs-controller`;
}

/** Values of the controller chart. */
export function controllerValues(config: ActionsRunnerControllerConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    serviceAccount: { create: true, name: controllerServiceAccountName(config.releaseName) },
    flags: { logLevel: "info", logFormat: "json" },
  };
  return deepmerge(defaults, config.controllerValues ?? {}) as Record<string, unknown>;
}

/** The name of the Secret a scale set reads its GitHub credentials from. */
export function scaleSetSecretName(name: string, auth: RunnerScaleSetAuth): string {
  return "secretName" in auth ? auth.secretName : `${name}-github`;
}

/** Secret data for an inline credential, or undefined when the Secret pre-exists. */
export function scaleSetSecretData(auth: RunnerScaleSetAuth): Record<string, string> | undefined {
  if ("secretName" in auth) return undefined;
  if ("token" in auth) return { github_token: auth.token };
  return {
    github_app_id: auth.appId,
    github_app_installation_id: auth.installationId,
    github_app_private_key: auth.privateKey,
  };
}

/** Values of one scale set's chart. */
export function scaleSetValues(
  name: string,
  set: RunnerScaleSetConfig,
  controller: { namespace: string; serviceAccountName: string },
): Record<string, unknown> {
  const mode = set.containerMode ?? "dind";
  if (mode === "kubernetes" && !set.workVolumeClaim) {
    throw new Error(`scale set ${name}: containerMode "kubernetes" needs a workVolumeClaim`);
  }
  const minRunners = set.minRunners ?? 0;
  const maxRunners = set.maxRunners ?? 4;
  if (minRunners < 0 || maxRunners < minRunners) {
    throw new Error(`scale set ${name}: 0 <= minRunners (${minRunners}) <= maxRunners (${maxRunners})`);
  }
  const runner: Record<string, unknown> = {
    name: "runner",
    image: set.runnerImage ?? "ghcr.io/actions/actions-runner:latest",
    command: ["/home/runner/run.sh"],
  };
  // dind renders its own template (see the module comment); the kubernetes
  // modes take the chart's, which mounts the work volume claim itself.
  const spec: Record<string, unknown> = mode === "dind"
    ? dindTemplateSpec(set, runner)
    : {
        ...(set.nodeSelector ? { nodeSelector: set.nodeSelector } : {}),
        ...(set.tolerations ? { tolerations: set.tolerations } : {}),
        containers: [{ ...runner, ...(set.resources ? { resources: set.resources } : {}) }],
      };
  const defaults: Record<string, unknown> = {
    githubConfigUrl: set.githubConfigUrl,
    githubConfigSecret: scaleSetSecretName(name, set.auth),
    runnerScaleSetName: name,
    minRunners,
    maxRunners,
    ...(set.runnerGroup ? { runnerGroup: set.runnerGroup } : {}),
    controllerServiceAccount: { namespace: controller.namespace, name: controller.serviceAccountName },
    ...(mode === "dind"
      ? {}
      : {
          containerMode: {
            type: mode,
            ...(mode === "kubernetes" && set.workVolumeClaim
              ? {
                  kubernetesModeWorkVolumeClaim: {
                    accessModes: set.workVolumeClaim.accessModes ?? ["ReadWriteOnce"],
                    storageClassName: set.workVolumeClaim.storageClassName,
                    resources: { requests: { storage: set.workVolumeClaim.storage } },
                  },
                }
              : {}),
          },
        }),
    template: {
      metadata: { annotations: { ...RUNNER_POD_ANNOTATIONS, ...(set.podAnnotations ?? {}) } },
      spec,
    },
  };
  return deepmerge(defaults, set.values ?? {}) as Record<string, unknown>;
}

export class ActionsRunnerController extends BaseConstruct<ActionsRunnerControllerConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly runnersNamespace: kplus.Namespace;
  public readonly controller: Helm;
  public readonly scaleSets: Record<string, Helm> = {};

  constructor(scope: Construct, id: string, config: ActionsRunnerControllerConfig) {
    super(scope, id, config);
    const namespace = this.config.namespace ?? DEFAULT_NAMESPACE;
    const runnersNamespace = this.config.runnersNamespace ?? DEFAULT_RUNNERS_NAMESPACE;
    const version = this.config.version ?? ARC_DEFAULT_VERSION;
    const releaseName = this.config.releaseName ?? DEFAULT_RELEASE;
    const local = this.config.localChartPaths ?? {};

    this.namespace = new kplus.Namespace(this, "namespace", { metadata: { name: namespace } });
    this.runnersNamespace = new kplus.Namespace(this, "runners-namespace", {
      metadata: { name: runnersNamespace },
    });

    // The CRDs ship in the chart's crds/ directory, which `helm template` leaves out unless asked.
    this.controller = new Helm(this, "controller", {
      chart: local.controller ?? `${ARC_CHART_REGISTRY}/gha-runner-scale-set-controller`,
      releaseName,
      ...(local.controller ? {} : { version }),
      namespace,
      values: controllerValues(this.config),
      helmFlags: ["--include-crds"],
    });

    const controller = { namespace, serviceAccountName: controllerServiceAccountName(releaseName) };
    for (const [name, set] of Object.entries(this.config.scaleSets)) {
      const data = scaleSetSecretData(set.auth);
      if (data) {
        new kplus.Secret(this, `${name}-github`, {
          metadata: { name: scaleSetSecretName(name, set.auth), namespace: runnersNamespace },
          stringData: data,
        });
      }
      const helm = new Helm(this, `scale-set-${name}`, {
        chart: local.scaleSet ?? `${ARC_CHART_REGISTRY}/gha-runner-scale-set`,
        releaseName: name,
        ...(local.scaleSet ? {} : { version }),
        namespace: runnersNamespace,
        values: scaleSetValues(name, set, controller),
      });
      for (const object of helm.apiObjects) {
        for (const [key, value] of Object.entries(syncWave(SCALE_SET_WAVE))) {
          object.metadata.addAnnotation(key, value);
        }
      }
      this.scaleSets[name] = helm;
    }
  }
}

export default ActionsRunnerController;
