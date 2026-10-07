import { ApiObject } from "cdk8s";
import { Construct } from "constructs";

export interface OllamaConfig {
  namespace: string;
  name: string;
  image: string;
  claimName: string;
  storageClassName: string;
  storageSize: string;
  port: number;
  resources: { requests?: Record<string, string>; limits?: Record<string, string> };
}

/** One Ollama server with an explicitly sized model-cache claim. Model loading is caller-managed. */
export class Ollama extends Construct {
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, config: OllamaConfig) {
    super(scope, id);
    const { name, namespace, port, claimName } = config;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ollama port must be between 1 and 65535");
    const labels = { app: name };
    this.serviceUrl = `http://${name}.${namespace}.svc.cluster.local:${port}`;
    new ApiObject(this, "models", {
      apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: claimName, namespace, labels },
      spec: { accessModes: ["ReadWriteOnce"], storageClassName: config.storageClassName, resources: { requests: { storage: config.storageSize } } },
    });
    new ApiObject(this, "deployment", {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace, labels },
      spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
        containers: [{ name, image: config.image, ports: [{ containerPort: port }], resources: config.resources,
          volumeMounts: [{ name: "models", mountPath: "/root/.ollama" }] }],
        volumes: [{ name: "models", persistentVolumeClaim: { claimName } }],
      } } },
    });
    new ApiObject(this, "service", {
      apiVersion: "v1", kind: "Service", metadata: { name, namespace, labels },
      spec: { type: "ClusterIP", selector: labels, ports: [{ port, targetPort: port }] },
    });
  }
}
