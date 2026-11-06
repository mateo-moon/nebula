import { renderConfidentialWorkload, validateStorage } from "nebula-cdk8s/confidential-workloads";

/** Fixed JSON protocol used by the Go controller. This process has no Kubernetes
 * client and never receives owner credentials. The owner CLI imports the same
 * renderer and native genpolicy implementation independently. */
export function renderRequest(input: any) {
  if (input.operation === "validate-storage") {
    validateStorage(input.storage);
    return {};
  }
  if (input.operation !== "render-workload") throw new Error("Unknown renderer operation");
  const result = renderConfidentialWorkload(input.workload, input.storages, { genpolicy: {
    executable: process.env.GENPOLICY ?? "/usr/local/bin/genpolicy",
    cacheDirectory: process.env.GENPOLICY_CACHE ?? "/tmp/genpolicy-cache",
  } });
  return { pod: result.pod, specSha256: result.specSha256, initDataSha256: result.identity.initDataSha256 };
}

export async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("Renderer input exceeds limit");
    chunks.push(chunk);
  }
  process.stdout.write(JSON.stringify(renderRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
}
