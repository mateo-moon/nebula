import type { Construct } from "constructs";
import { KubeDaemonSet, type Container, type Volume } from "cdk8s-plus-33/lib/imports/k8s";
import type { Toleration } from "../../../core";

export interface HostReconcilerConfig {
  name: string;
  namespace: string;
  image: string;
  nodeSelector: Record<string, string>;
  tolerations?: Toleration[];
}

export function validateHostReconciler(config: HostReconcilerConfig): void {
  for (const value of [config.name, config.namespace]) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) throw new Error("host reconciler name and namespace must be DNS labels");
  }
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error("host reconciler image must be digest-pinned");
  if (!Object.keys(config.nodeSelector).length) throw new Error("host reconciler requires an explicit node selector");
}

type HostContainerAccess = Pick<Container, "env" | "securityContext" | "volumeMounts">;

interface HostReconcilerSteps {
  apply: HostContainerAccess & { name: string; command: string[] };
  verify: HostContainerAccess & { checkCommand: string[] };
  volumes: Volume[];
}

/** Run the apply step once, then check readiness using the verifier's own permissions. */
export function createHostReconcilerDaemonSet(
  scope: Construct,
  config: HostReconcilerConfig,
  { apply, verify, volumes }: HostReconcilerSteps,
): void {
  const labels = { app: config.name };
  const { checkCommand, ...verifierAccess } = verify;
  new KubeDaemonSet(scope, "daemonset", {
    metadata: { name: config.name, namespace: config.namespace },
    spec: {
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          nodeSelector: config.nodeSelector,
          tolerations: config.tolerations ?? [{ operator: "Exists" }],
          automountServiceAccountToken: false,
          initContainers: [{ ...apply, image: config.image }],
          containers: [{
            ...verifierAccess,
            name: "verify",
            image: config.image,
            command: ["sleep", "infinity"],
            readinessProbe: {
              exec: { command: checkCommand },
              periodSeconds: 300,
              timeoutSeconds: 60,
              failureThreshold: 1,
            },
          }],
          volumes,
        },
      },
    },
  });
}
