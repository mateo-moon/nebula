import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { isDigestImage } from "../confidential-guests/types";
import { publicConfig } from "../trustee/validation";

export interface ConfidentialStorageDevicesConfig {
  name: string;
  namespace: string;
  nodeName: string;
  image: string;
  pluginIndex: string;
  /** Exact measured profiles and storage binding names served on this node. */
  bindings: readonly { profile: string; storage: string }[];
  nriDirectory?: string;
}

/** Host device plumbing, using tool-node-coco's namespace-scoped NRI plugin.
 * Device injection grants no key access; the guest's native policy independently
 * restricts the controls to its measured storage helper. */
export class ConfidentialStorageDevices extends BaseConstruct<ConfidentialStorageDevicesConfig> {
  readonly deployment: ApiObject;
  constructor(scope: Construct, id: string, config: ConfidentialStorageDevicesConfig) {
    super(scope, id, publicConfig("ConfidentialStorageDevices", config));
    const name = /^[a-z][a-z0-9-]{0,39}$/, node = /^[a-z0-9][a-z0-9.-]{0,252}$/;
    const directory = config.nriDirectory ?? "/var/run/nri";
    if (![config.name, config.namespace].every(v => name.test(v)) || !node.test(config.nodeName) ||
        !isDigestImage(config.image) || !/^[0-9]{2}$/.test(config.pluginIndex) ||
        !/^\/[A-Za-z0-9/_-]+$/.test(directory) || !config.bindings.length ||
        config.bindings.some(b => !name.test(b.profile) || !name.test(b.storage)) ||
        new Set(config.bindings.map(b => `${b.profile}/${b.storage}`)).size !== config.bindings.length) {
      throw new TypeError("Invalid confidential storage device configuration");
    }
    this.deployment = new ApiObject(this, "deployment", {
      apiVersion: "apps/v1", kind: "Deployment",
      metadata: { name: config.name, namespace: config.namespace, annotations: { "argocd.argoproj.io/sync-wave": "-2" } },
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: config.name } },
        template: { metadata: { labels: { app: config.name } }, spec: {
          nodeName: config.nodeName, automountServiceAccountToken: false, enableServiceLinks: false,
          containers: [{ name: "injector", image: config.image,
            args: ["--idx", config.pluginIndex, "--socket-path", `${directory}/nri.sock`,
              "--namespace", config.namespace, "--own-namespace", config.namespace,
              "--runtime-handler", "kata-qemu-snp", "--device-major", "10", "--device-minor", "258",
              ...config.bindings.flatMap(b => ["--storage-generated-binding", `${b.profile}-=nebula-storage-${b.storage}`])],
            securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            volumeMounts: [{ name: "nri", mountPath: directory, readOnly: true }],
            resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
            readinessProbe: { httpGet: { path: "/readyz", port: 8080 }, periodSeconds: 2 },
          }], volumes: [{ name: "nri", hostPath: { path: directory, type: "Directory" } }],
        } } },
    });
  }
}
