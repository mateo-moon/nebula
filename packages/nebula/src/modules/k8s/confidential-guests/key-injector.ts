import { Construct } from "constructs";
import { IntOrString, KubeDeployment, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import {
  dnsLabel, dnsSubdomain, fail, hostPath, image, integer, knownFields, labels, pullSecrets, waveAnnotation,
} from "./validate";

/** A guest container the injector hands the key device to: `<pod>=<container>`. */
export interface NriKeyBinding {
  /** Guest Pod name in the injector's namespace. */
  readonly pod: string;
  /** Container of that Pod. */
  readonly container: string;
}

export interface NriKeyInjectorProps {
  /** Deployment name. */
  readonly name: string;
  /** Namespace of the Deployment, and the only namespace whose Pods it injects into. */
  readonly namespace: string;
  /**
   * The namespace the injector serves. It must equal `namespace`: an
   * injector never reaches into another deployment's guests. Stating it
   * makes that explicit; any other value is refused.
   */
  readonly targetNamespace?: string;
  /** Node the injector runs on (the node of the guests it serves). */
  readonly nodeName: string;
  /** Digest-pinned injector image (the NRI plugin). */
  readonly image: string;
  /** NRI plugin index: two digits, which order plugins on the node. */
  readonly pluginIndex: string;
  /** Runtime handler of the guests (for example a Kata Containers SEV-SNP handler). */
  readonly runtimeHandler: string;
  /** Character device the injector adds to each bound container. */
  readonly device: { readonly major: number; readonly minor: number };
  /** Bound containers, in order; at least one, each once. */
  readonly bindings: readonly NriKeyBinding[];
  /**
   * Host directory of the NRI socket (`nri.sock` inside it). The directory is
   * mounted, never the socket itself, so the plugin reconnects when the
   * runtime recreates the socket. Default `/var/run/nri`, the upstream NRI
   * default.
   */
  readonly nriDirectory?: string;
  readonly imagePullSecrets?: readonly string[];
  /** Pod labels and selector. Default `{ app: "<namespace>-<name>" }`. */
  readonly podLabels?: Readonly<Record<string, string>>;
  /** Argo CD sync wave. Default -1. */
  readonly syncWave?: number;
}

const WHERE = "NriKeyInjector";
const PLUGIN_INDEX = /^[0-9]{2}$/;
const RUNTIME_HANDLER = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DEFAULT_NRI_DIRECTORY = "/var/run/nri";
const PROPS_FIELDS = [
  "name", "namespace", "targetNamespace", "nodeName", "image", "pluginIndex", "runtimeHandler", "device", "bindings", "nriDirectory",
  "imagePullSecrets", "podLabels", "syncWave",
];

/**
 * An NRI plugin that hands a key device to the storage and attestation
 * containers of named guests: one Deployment on the guests' node, restricted
 * (root without capabilities, read-only root filesystem, no service account
 * token), Ready once registered with the runtime.
 */
export class NriKeyInjector extends Construct {
  /** The plugin's command-line arguments. */
  public readonly args: readonly string[];

  constructor(scope: Construct, id: string, props: NriKeyInjectorProps) {
    super(scope, id);
    knownFields(WHERE, "props", props, PROPS_FIELDS);
    const name = dnsLabel(WHERE, "name", props.name);
    const namespace = dnsLabel(WHERE, "namespace", props.namespace);
    if (props.targetNamespace !== undefined && props.targetNamespace !== namespace) {
      fail(WHERE, `targetNamespace ${JSON.stringify(props.targetNamespace)} differs from namespace ${JSON.stringify(namespace)}; an injector serves only its own namespace`);
    }
    const nodeName = dnsSubdomain(WHERE, "nodeName", props.nodeName);
    const pinned = image(WHERE, "image", props.image);
    if (typeof props.pluginIndex !== "string" || !PLUGIN_INDEX.test(props.pluginIndex)) {
      fail(WHERE, `pluginIndex must be two digits, got ${JSON.stringify(props.pluginIndex)}`);
    }
    if (typeof props.runtimeHandler !== "string" || props.runtimeHandler.length > 253 || !RUNTIME_HANDLER.test(props.runtimeHandler)) {
      fail(WHERE, `runtimeHandler must be a runtime handler name, got ${JSON.stringify(props.runtimeHandler)}`);
    }
    const major = integer(WHERE, "device.major", props.device?.major, 0, 4095);
    const minor = integer(WHERE, "device.minor", props.device?.minor, 0, (1 << 20) - 1);
    const bindings = validBindings(props.bindings);
    const nri = hostPath(WHERE, "nriDirectory", props.nriDirectory ?? DEFAULT_NRI_DIRECTORY);
    if (nri.endsWith(".sock")) fail(WHERE, `nriDirectory must be the socket's directory, not the socket`);
    const podLabels = labels(WHERE, "podLabels", props.podLabels ?? { app: `${namespace}-${name}` });
    const imagePullSecrets = pullSecrets(WHERE, props.imagePullSecrets);
    const wave = waveAnnotation(WHERE, "syncWave", props.syncWave ?? -1);

    this.args = Object.freeze([
      "--idx", props.pluginIndex, "--socket-path", `${nri}/nri.sock`, "--namespace", namespace, "--runtime-handler", props.runtimeHandler,
      "--device-major", String(major), "--device-minor", String(minor),
      ...bindings.flatMap(({ pod, container }) => ["--binding", `${pod}=${container}`]),
    ]);
    new KubeDeployment(this, "deployment", {
      metadata: { name, namespace, annotations: wave },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { ...podLabels } },
        template: {
          metadata: { labels: { ...podLabels } },
          spec: {
            nodeName,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            ...(imagePullSecrets ? { imagePullSecrets } : {}),
            containers: [{
              name: "injector",
              image: pinned,
              securityContext: {
                runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] },
              },
              args: [...this.args],
              volumeMounts: [{ name: "nri", mountPath: nri, readOnly: true }],
              resources: {
                requests: { cpu: Quantity.fromString("10m"), memory: Quantity.fromString("32Mi") },
                limits: { memory: Quantity.fromString("128Mi") },
              },
              ports: [{ name: "health", containerPort: 8080 }],
              readinessProbe: { httpGet: { path: "/readyz", port: IntOrString.fromString("health") }, periodSeconds: 2 },
            }],
            volumes: [{ name: "nri", hostPath: { path: nri, type: "Directory" } }],
          },
        },
      },
    });
  }
}

function validBindings(value: unknown): NriKeyBinding[] {
  if (!Array.isArray(value) || value.length === 0) fail(WHERE, `bindings must list at least one binding`);
  const seen = new Set<string>();
  return value.map((binding: NriKeyBinding, i) => {
    knownFields(WHERE, `binding ${i}`, binding, ["pod", "container"]);
    const pod = binding.pod, container = binding.container;
    if (typeof pod !== "string" || pod.length > 253 || !pod.split(".").every(part => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(part))) {
      fail(WHERE, `binding ${i} names an invalid Pod ${JSON.stringify(pod)}`);
    }
    if (typeof container !== "string" || container.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(container)) {
      fail(WHERE, `binding ${i} names an invalid container ${JSON.stringify(container)}`);
    }
    const key = `${pod}=${container}`;
    if (seen.has(key)) fail(WHERE, `binding ${key} is listed twice`);
    seen.add(key);
    return { pod, container };
  });
}
