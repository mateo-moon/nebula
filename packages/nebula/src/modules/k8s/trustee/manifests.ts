import {
  IntOrString, Quantity, type Container, type KubeDeploymentProps, type KubeNetworkPolicyProps,
  type PodSpec,
} from "cdk8s-plus-33/lib/imports/k8s";
import type { TrusteeConfig } from "./types";

// Plans are ordinary JSON for genpolicy and canonical hashing. The generated
// Kubernetes classes use Quantity/IntOrString wrappers at the rendering boundary.
export type TrusteeContainer = Pick<Container,
  "name" | "image" | "imagePullPolicy" | "command" | "args" | "env" | "securityContext" | "ports" | "volumeMounts"
> & {
  readonly resources: {
    readonly requests: Readonly<Record<string, string>>;
    readonly limits: Readonly<Record<string, string>>;
  };
  readonly readinessProbe?: { readonly tcpSocket: { readonly port: number }; readonly periodSeconds: number };
};

type TrusteePodSpec = Pick<PodSpec,
  "runtimeClassName" | "automountServiceAccountToken" | "enableServiceLinks" | "nodeSelector" | "restartPolicy" | "securityContext"
> & {
  readonly containers: readonly TrusteeContainer[];
  readonly volumes: readonly {
    readonly name: string;
    readonly emptyDir: { readonly medium: "Memory"; readonly sizeLimit: string };
  }[];
};

export type TrusteePodManifest = {
  readonly apiVersion: "v1";
  readonly kind: "Pod";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations: Readonly<Record<string, string>>;
  };
  readonly spec: TrusteePodSpec;
};

export type TrusteeDeploymentManifest = {
  readonly apiVersion: "apps/v1";
  readonly kind: "Deployment";
  readonly metadata: Pick<TrusteePodManifest["metadata"], "name" | "namespace" | "labels">;
  readonly spec: {
    readonly replicas: 1;
    readonly strategy: { readonly type: "Recreate" };
    readonly selector: { readonly matchLabels: Readonly<Record<string, string>> };
    readonly template: {
      readonly metadata: Pick<TrusteePodManifest["metadata"], "labels" | "annotations">;
      readonly spec: TrusteePodSpec;
    };
  };
};

export function deploymentFor(pod: TrusteePodManifest): TrusteeDeploymentManifest {
  const { name, namespace, labels, annotations } = pod.metadata;
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace, labels },
    spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations }, spec: pod.spec } } };
}

export function deploymentProps(pod: TrusteePodManifest): KubeDeploymentProps {
  const { metadata, spec } = deploymentFor(pod);
  const quantities = (values: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Quantity.fromString(value)]));
  return { metadata, spec: { ...spec, template: { ...spec.template, spec: {
    ...pod.spec,
    containers: pod.spec.containers.map(({ resources, readinessProbe, ...container }) => ({
      ...container,
      resources: { requests: quantities(resources.requests), limits: quantities(resources.limits) },
      readinessProbe: readinessProbe && {
        ...readinessProbe, tcpSocket: { port: IntOrString.fromNumber(readinessProbe.tcpSocket.port) },
      },
    })),
    volumes: pod.spec.volumes.map(({ name, emptyDir }) => ({ name,
      emptyDir: { ...emptyDir, sizeLimit: Quantity.fromString(emptyDir.sizeLimit) },
    })),
  } } } };
}

export function ingressPolicyProps(pod: TrusteePodManifest, clients: TrusteeConfig["clients"], port: number): KubeNetworkPolicyProps {
  const { name, namespace, labels } = pod.metadata;
  return { metadata: { name, namespace }, spec: {
    podSelector: { matchLabels: labels }, policyTypes: ["Ingress"], ingress: [{
      from: clients.map(client => ({
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": client.namespace } },
        podSelector: { matchLabels: { ...client.podLabels } },
      })),
      ports: [{ port: IntOrString.fromNumber(port), protocol: "TCP" }],
    }],
  } };
}
