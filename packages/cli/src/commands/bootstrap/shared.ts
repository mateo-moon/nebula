/**
 * Shared bootstrap helpers used by every provider.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { apply } from "../apply";

export function log(msg: string): void {
  console.log(msg);
}

export function exec(
  cmd: string,
  options?: { silent?: boolean; ignoreErrors?: boolean },
): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: options?.silent ? ["pipe", "pipe", "pipe"] : "inherit",
    });
  } catch (error: any) {
    if (options?.silent || options?.ignoreErrors) {
      return error.stdout || "";
    }
    throw error;
  }
}

export function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `KUBECONFIG="..." ` command prefix to target a specific cluster (empty for current context). */
export function kubeconfigPrefix(kubeconfig?: string): string {
  return kubeconfig ? `KUBECONFIG="${kubeconfig}" ` : "";
}

export function kindClusterExists(name: string): boolean {
  try {
    const result = execSync(`kind get clusters`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.split("\n").includes(name);
  } catch {
    return false;
  }
}

export async function createKindCluster(name: string): Promise<void> {
  log("");
  log("🐳 Step 1: Creating Kind cluster");
  log("─".repeat(50));

  if (!commandExists("kind")) {
    throw new Error("kind is not installed. Install it with: brew install kind");
  }

  if (kindClusterExists(name)) {
    log(`   ✅ Cluster '${name}' already exists`);
    exec(`kubectl config use-context kind-${name}`, { silent: true });
    return;
  }

  log(`   Creating cluster '${name}'...`);
  const kindConfig = `
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
`;
  const configPath = `/tmp/kind-config-${name}.yaml`;
  fs.writeFileSync(configPath, kindConfig);
  exec(`kind create cluster --name ${name} --config ${configPath}`);
  fs.unlinkSync(configPath);
  log(`   ✅ Cluster '${name}' created`);
}

/** Wait until all Crossplane providers report Healthy=True on the target cluster. */
export async function waitForProviders(
  timeoutSeconds: number,
  kubeconfig?: string,
): Promise<void> {
  const kc = kubeconfigPrefix(kubeconfig);
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    const result = exec(
      `${kc}kubectl get providers -o jsonpath="{.items[*].status.conditions[?(@.type=='Healthy')].status}" 2>/dev/null || echo ""`,
      { silent: true },
    );
    const statuses = result
      .trim()
      .split(" ")
      .filter((s) => s);
    if (statuses.length > 0 && statuses.every((s) => s === "True")) return;
    await sleep(5000);
  }
  log("   ⚠️  Some providers may not be fully healthy yet");
}

/** Wait until the given CRDs exist on the target cluster (e.g. installed by an operator at runtime). */
export async function waitForCrds(
  crds: string[],
  timeoutSeconds: number,
  kubeconfig?: string,
): Promise<void> {
  const kc = kubeconfigPrefix(kubeconfig);
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    const missing = crds.filter(
      (c) =>
        !exec(`${kc}kubectl get crd ${c} -o name 2>/dev/null || echo ""`, {
          silent: true,
        }).trim(),
    );
    if (missing.length === 0) {
      log("   ✅ Required CRDs installed");
      return;
    }
    log(`   Waiting for CRDs (${missing.length} missing)...`);
    await sleep(10000);
  }
  throw new Error(`CRDs not installed within ${timeoutSeconds}s: ${crds.join(", ")}`);
}

/** Synth (in-process) into `outdir`, then apply it — optionally to another cluster via kubeconfig. */
export async function synthAndApply(
  outdir: string,
  synthFn: () => void,
  kubeconfig?: string,
): Promise<void> {
  fs.rmSync(outdir, { recursive: true, force: true });
  synthFn();
  const prev = process.env.KUBECONFIG;
  if (kubeconfig) process.env.KUBECONFIG = kubeconfig;
  try {
    await apply({ file: `${outdir}/*.k8s.yaml` });
  } finally {
    if (kubeconfig) {
      if (prev === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = prev;
    }
  }
}
