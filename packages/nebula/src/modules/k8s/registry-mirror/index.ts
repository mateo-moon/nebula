/**
 * RegistryMirror — a pull-through cache in front of one upstream image
 * registry (Docker Hub by default), for clusters whose jobs pull the same
 * base images over and over from throwaway docker daemons.
 *
 * It runs the CNCF Distribution registry in proxy mode: a pull that reaches
 * the mirror is served from its cache when the layer is there and fetched
 * from the upstream once when it is not. The cache is an emptyDir with a size
 * limit, so a rolled node costs one re-warm and nothing pins the pod to a
 * node; entries expire after `ttl`. A docker daemon uses it through
 * `registry-mirrors` in its daemon.json, or `--registry-mirror` on its
 * command line, with the {@link RegistryMirror.endpoint}. Only images of the
 * upstream's namespace (docker.io for Docker Hub) go through the mirror.
 *
 * @example
 * ```typescript
 * const mirror = new RegistryMirror(chart, "mirror", {});
 * mirror.endpoint; // http://registry-mirror.registry-mirror.svc.cluster.local:5000
 * ```
 */
import { Construct } from "constructs";
import { Duration, Size } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct } from "../../../core";

export interface RegistryMirrorConfig {
  /** Namespace (default "registry-mirror"), created by the module. */
  namespace?: string;
  /** The registry the mirror caches (default Docker Hub). */
  upstream?: string;
  /** Distribution image (default "registry:3.0.0"). */
  image?: string;
  /** Size of the cache; the emptyDir's limit and the pod's ephemeral-storage request (default 30Gi). */
  cacheSize?: string;
  /** How long a cached image stays before it is fetched again (default "168h"). */
  ttl?: string;
  nodeSelector?: Record<string, string>;
}

export const DEFAULT_UPSTREAM = "https://registry-1.docker.io";
export const DEFAULT_IMAGE = "registry:3.0.0";
export const MIRROR_PORT = 5000;
const NAME = "registry-mirror";

/** The endpoint of a mirror in `namespace`, for daemons declared in other charts. */
export function mirrorEndpoint(namespace = NAME): string {
  return `http://${NAME}.${namespace}.svc.cluster.local:${MIRROR_PORT}`;
}

export class RegistryMirror extends BaseConstruct<RegistryMirrorConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly deployment: kplus.Deployment;
  public readonly service: kplus.Service;
  /** The URL a docker daemon lists under `registry-mirrors`. */
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, config: RegistryMirrorConfig) {
    super(scope, id, config);
    const namespace = this.config.namespace ?? NAME;
    const cacheSize = Size.gibibytes(parseGibibytes(this.config.cacheSize ?? "30Gi"));
    this.namespace = new kplus.Namespace(this, "namespace", { metadata: { name: namespace } });

    const cache = kplus.Volume.fromEmptyDir(this, "cache", "cache", { sizeLimit: cacheSize });
    this.deployment = new kplus.Deployment(this, "deployment", {
      metadata: { name: NAME, namespace },
      replicas: 1,
      // One cache at a time: a second pod would start empty beside it.
      strategy: kplus.DeploymentStrategy.recreate(),
      containers: [
        {
          name: "registry",
          image: this.config.image ?? DEFAULT_IMAGE,
          imagePullPolicy: kplus.ImagePullPolicy.IF_NOT_PRESENT,
          portNumber: MIRROR_PORT,
          // The image has no USER; the registry only ever writes into the cache mount.
          securityContext: { user: 1000, group: 1000 },
          envVariables: {
            REGISTRY_PROXY_REMOTEURL: kplus.EnvValue.fromValue(this.config.upstream ?? DEFAULT_UPSTREAM),
            REGISTRY_PROXY_TTL: kplus.EnvValue.fromValue(this.config.ttl ?? "168h"),
            REGISTRY_STORAGE_DELETE_ENABLED: kplus.EnvValue.fromValue("true"),
            REGISTRY_LOG_LEVEL: kplus.EnvValue.fromValue("warn"),
          },
          resources: {
            cpu: { request: kplus.Cpu.millis(100) },
            memory: { request: Size.mebibytes(256), limit: Size.gibibytes(1) },
            ephemeralStorage: { request: cacheSize, limit: cacheSize },
          },
          volumeMounts: [{ path: "/var/lib/registry", volume: cache }],
          readiness: kplus.Probe.fromHttpGet("/v2/", { port: MIRROR_PORT, periodSeconds: Duration.seconds(10) }),
          liveness: kplus.Probe.fromHttpGet("/v2/", { port: MIRROR_PORT, periodSeconds: Duration.seconds(30) }),
        },
      ],
    });
    if (this.config.nodeSelector) {
      for (const [key, value] of Object.entries(this.config.nodeSelector)) {
        this.deployment.scheduling.attract(kplus.Node.labeled(kplus.NodeLabelQuery.is(key, value)));
      }
    }
    this.service = this.deployment.exposeViaService({
      name: NAME,
      serviceType: kplus.ServiceType.CLUSTER_IP,
      ports: [{ port: MIRROR_PORT, targetPort: MIRROR_PORT }],
    });
    // The full name: a rootless daemon resolves it inside its own network namespace, without search domains.
    this.endpoint = mirrorEndpoint(namespace);
  }
}

function parseGibibytes(quantity: string): number {
  const match = /^(\d+(?:\.\d+)?)Gi$/.exec(quantity);
  if (!match) throw new Error(`cacheSize must be a Gi quantity, got ${quantity}`);
  return Number(match[1]);
}

export default RegistryMirror;
