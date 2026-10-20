import { readFileSync } from "node:fs";
import { request } from "node:https";

export class KubernetesError extends Error {
  constructor(readonly status: number) { super(`Kubernetes API returned HTTP ${status}`); }
}
export interface Kubernetes {
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>;
}
export class InClusterKubernetes implements Kubernetes {
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const host = process.env.KUBERNETES_SERVICE_HOST, port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
    if (!host || !/^[0-9]+$/.test(port) || !path.startsWith("/") || path.includes("..")) throw new Error("Invalid Kubernetes endpoint");
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((accept, reject) => {
      const req = request({ host, port: Number(port), path, method, agent: false,
        ca: readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
        headers: {
          Authorization: `Bearer ${readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim()}`,
          "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json",
          ...(bytes ? { "Content-Length": bytes.length } : {}),
        },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) req.destroy(new Error("Kubernetes response limit exceeded"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new KubernetesError(res.statusCode ?? 0)); return;
          }
          try { accept(JSON.parse(Buffer.concat(chunks).toString()) as T); }
          catch { reject(new Error("Invalid Kubernetes response")); }
        });
        res.on("error", reject);
      });
      req.setTimeout(30_000, () => req.destroy(new Error("Kubernetes API timeout")));
      req.on("error", reject);
      req.end(bytes);
    });
  }
}
