// Synthetic inputs shared by the confidential-guests construct tests. Every
// name, domain and image here is an example value.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  canonicalJson,
  measuredGuest,
  type GuestLifecycleProps,
  type GuestLifecycleRole,
  type GuestPodManifest,
} from "../src/modules/k8s/confidential-guests";

export const DOMAIN = "guests.example.com";
export const NAMESPACE = "guests";
export const NODE = "node-a";
export const RUNTIME = "kata-qemu-snp";
export const image = (name: string, digit = "1") => `ghcr.io/example/${name}@sha256:${digit.repeat(64)}`;
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The init-data of a synthetic policy document, and its HOST_DATA. */
export function initData(label: string) {
  const text = `version = "0.1.0"\nalgorithm = "sha384"\n[data]\n"policy.rego" = "package agent_policy # ${label}\\n"\n`;
  return { ccInitData: gzipSync(Buffer.from(text)).toString("base64"), initDataSha256: sha256(text) };
}

const health = (path: string) => ({ httpGet: { path, port: 9080 }, periodSeconds: 5 });

/** An unmeasured guest template for a role. */
export function template(role: "primary" | "maintenance", opts: { claim?: string; image?: string; release?: string } = {}): GuestPodManifest {
  const holder = `guest-${role}`;
  const primary = role === "primary";
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: holder, namespace: NAMESPACE, labels: { app: "guests", role },
      annotations: { [`${DOMAIN}/release`]: opts.release ?? "r1" } },
    spec: {
      runtimeClassName: RUNTIME, nodeName: NODE, restartPolicy: "Never", terminationGracePeriodSeconds: primary ? 120 : 60,
      automountServiceAccountToken: false, enableServiceLinks: false,
      initContainers: [{ name: "initialize", image: image("storage"), args: ["install"] }],
      containers: [
        { name: "storage", image: image("storage"), args: ["serve"] },
        { name: "attest", image: image("attest"), readinessProbe: health("/livez") },
        ...(primary ? [{ name: "app", image: opts.image ?? image("app"), readinessProbe: health("/readyz") }] : []),
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: opts.claim ?? (primary ? "guest-primary-data-v2" : "guest-maintenance-v1") } },
        { name: "scratch", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
        { name: "release", configMap: { name: "signed-release-0123456789abcdef" } },
      ],
    },
  };
}

/** A template measured against a synthetic policy. */
export function measured(role: "primary" | "maintenance", opts: Parameters<typeof template>[1] = {}): GuestPodManifest {
  const pod = template(role, opts);
  return measuredGuest(pod, { canonicalPodSha256: sha256(canonicalJson(pod)), ...initData(`${role}-${opts.release ?? "r1"}`) });
}

export function roles(): GuestLifecycleRole[] {
  return [
    {
      role: "primary", holder: "guest-primary", claim: "guest-primary-data-v2", generation: 2, graceSeconds: 120,
      live: ["attest", "/livez", 9080], ready: ["app", "/readyz", 9080],
      releases: { r1: measured("primary"), r2: measured("primary", { claim: "${DISK}", release: "r2", image: image("app", "2") }) },
      current: "r2", previous: "r1", rolloutId: 4,
      stage: { name: "guest-primary-stage", claim: "guest-primary-stage-v1", containers: ["storage", "attest"] },
      importedLedger: { name: "primary-budget-v1", state: { version: 1, attempts: [] } },
    },
    {
      role: "maintenance", holder: "guest-maintenance", claim: "guest-maintenance-v1", generation: 1, graceSeconds: 60,
      live: ["attest", "/livez", 9080], ready: ["attest", "/livez", 9080],
      releases: { m1: measured("maintenance") }, current: "m1",
    },
  ];
}

export const CONTROLLER_CODE = { "__init__.py": "", "lifecycle.py": "def main():\n    pass\n", "identity.py": "SHARED = ()\n" };

export function lifecycleProps(extra: Partial<GuestLifecycleProps> = {}): GuestLifecycleProps {
  return {
    namespace: NAMESPACE, nodeName: NODE, runtimeClassName: RUNTIME, labelDomain: DOMAIN,
    controller: { code: CONTROLLER_CODE, runtimeImage: image("python"), package: "guest_control" },
    roles: roles(), budget: { epoch: 2, limit: 3 }, startupSeconds: 600,
    rollout: { limit: 3, stageSeconds: 300, backoffSeconds: 60, settleSeconds: 10 },
    ...extra,
  };
}
