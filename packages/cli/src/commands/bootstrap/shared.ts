/**
 * Shared bootstrap helpers used by every provider.
 *
 * Shell execution is provided by {@link ./exec} (no-shell `run`/`kubectl`).
 * This module layers bootstrap-specific orchestration on top: Kind lifecycle,
 * namespace/CRD/provider polling, and in-process synth+apply.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Re-export the no-shell primitives so provider modules can import everything
// from "./shared" without depending on "./exec" directly.
export {
  run,
  kubectl,
  kcEnv,
  commandExists,
  sleep,
  log,
  waitFor,
  type RunOptions,
  type KubectlOptions,
  type WaitForOptions,
} from "./exec";
import { run, kubectl, log, sleep, waitFor, commandExists } from "./exec";

/** Lowercase DNS-1123 label (Kind cluster / kubectl context names). */
const RFC1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function validateName(name: string): void {
  if (!RFC1123_LABEL.test(name) || name.length > 63) {
    throw new Error(
      `Invalid cluster name "${name}" (must be a lowercase DNS-1123 label, ≤63 chars).`,
    );
  }
}

/** True if a Kind cluster named `name` exists. */
export function kindClusterExists(name: string): boolean {
  return run("kind", ["get", "clusters"], { silent: true, ignoreErrors: true })
    .split("\n")
    .includes(name);
}

/** Idempotently apply a Namespace (replaces `kubectl create ns … | kubectl apply -f -`). */
export function ensureNamespace(ns: string, kubeconfig?: string): void {
  kubectl(["apply", "-f", "-"], {
    kubeconfig,
    silent: true,
    ignoreErrors: true,
    input: `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`,
  });
}

export async function createKindCluster(name: string): Promise<void> {
  validateName(name);
  log("");
  log("🐳 Step 1: Creating Kind cluster");
  log("─".repeat(50));

  if (!commandExists("kind")) {
    throw new Error("kind is not installed. Install it with: brew install kind");
  }

  if (kindClusterExists(name)) {
    log(`   ✅ Cluster '${name}' already exists`);
    kubectl(["config", "use-context", `kind-${name}`], {
      silent: true,
      ignoreErrors: true,
    });
    return;
  }

  log(`   Creating cluster '${name}'...`);
  const kindConfig = `
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
`;
  // Write the config inside a private temp dir and clean up in a `finally` so a
  // failed `kind create` never leaks the file or follows a planted symlink.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-kind-"));
  const configPath = path.join(tmpDir, "kind-config.yaml");
  try {
    fs.writeFileSync(configPath, kindConfig, { mode: 0o600 });
    run("kind", ["create", "cluster", "--name", name, "--config", configPath]);
    log(`   ✅ Cluster '${name}' created`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Wait until all Crossplane providers report Healthy=True on the target cluster. */
export async function waitForProviders(
  timeoutSeconds: number,
  kubeconfig?: string,
): Promise<void> {
  await waitFor(
    {
      label: "Crossplane providers",
      timeoutMs: timeoutSeconds * 1000,
      onTimeout: "warn",
    },
    () => {
      const result = kubectl(
        [
          "get",
          "providers",
          "-o",
          "jsonpath={.items[*].status.conditions[?(@.type=='Healthy')].status}",
        ],
        { kubeconfig, silent: true, ignoreErrors: true },
      );
      const statuses = result.trim().split(" ").filter((s) => s);
      return statuses.length > 0 && statuses.every((s) => s === "True");
    },
  );
}

/** Wait until the given CRDs exist on the target cluster (installed by an operator at runtime). */
export async function waitForCrds(
  crds: string[],
  timeoutSeconds: number,
  kubeconfig?: string,
): Promise<void> {
  await waitFor(
    {
      label: `CRDs (${crds.join(", ")})`,
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: 10000,
      onTimeout: "throw",
    },
    () => {
      const missing = crds.filter(
        (c) =>
          !kubectl(["get", "crd", c, "-o", "name"], {
            kubeconfig,
            silent: true,
            ignoreErrors: true,
          }).trim(),
      );
      if (missing.length === 0) {
        log("   ✅ Required CRDs installed");
        return true;
      }
      log(`   Waiting for CRDs (${missing.length} missing)...`);
      return false;
    },
  );
}

/**
 * Wait until EVERY Crossplane managed resource of the given kinds reports
 * Ready=True. Used to gate cluster creation on the node IAM being fully
 * provisioned: CAPA launches the EC2 instance the moment its instance profile
 * exists and does NOT wait for Crossplane to finish attaching the role's
 * policies, so a node launched mid-attach can't read its Secrets-Manager
 * bootstrap data and silently fails cloud-init. We compare the number of
 * Ready=True conditions against the number of items so a not-yet-observed
 * resource (no condition yet) correctly counts as not-ready.
 */
export async function waitForManagedReady(
  kinds: string[],
  timeoutSeconds: number,
  kubeconfig?: string,
): Promise<void> {
  await waitFor(
    {
      label: `node IAM ready (${kinds.length} kinds)`,
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: 5000,
      onTimeout: "throw",
    },
    () => {
      for (const kind of kinds) {
        const opts = { kubeconfig, silent: true, ignoreErrors: true } as const;
        const items = kubectl(["get", kind, "-o", "jsonpath={.items[*].metadata.name}"], opts)
          .trim().split(" ").filter(Boolean);
        if (items.length === 0) return false; // expected resources not created yet
        const ready = kubectl(
          ["get", kind, "-o", "jsonpath={.items[*].status.conditions[?(@.type=='Ready')].status}"],
          opts,
        ).trim().split(" ").filter(Boolean);
        if (ready.length !== items.length || !ready.every((s) => s === "True")) return false;
      }
      log("   ✅ Node IAM ready (role + instance profile + policy attachments)");
      return true;
    },
  );
}
