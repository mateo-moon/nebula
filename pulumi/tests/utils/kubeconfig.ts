import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface KubeconfigInfo {
  path: string;
  content: string;
}

const expandHome = (input: string) =>
  input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;

const defaultCandidates = [
  process.env.NEBULA_TEST_KUBECONFIG,
  process.env.ORBSTACK_KUBECONFIG,
  process.env.KUBECONFIG,
  "~/.orbstack/k8s/config.yml",
  "~/.kube/config",
];

export function getOrbstackKubeconfig(): KubeconfigInfo {
  const candidates = Array.from(
    new Set(
      defaultCandidates
        .filter((candidate): candidate is string => Boolean(candidate && candidate.trim()))
        .map(candidate => expandHome(candidate))
    )
  );

  for (const candidate of candidates) {
    const fullPath = path.resolve(candidate);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, "utf8");
        if (!content || !content.trim()) {
          console.warn(`[getOrbstackKubeconfig] Skipping empty kubeconfig at ${fullPath}`);
          continue;
        }
        return { path: fullPath, content };
      }
    } catch (err) {
      console.warn(`[getOrbstackKubeconfig] Failed to read ${fullPath}: ${(err as Error).message}`);
    }
  }

  throw new Error(
    `[getOrbstackKubeconfig] Unable to locate kubeconfig file. Set NEBULA_TEST_KUBECONFIG or ensure ~/.orbstack/k8s/config.yml exists.`
  );
}



