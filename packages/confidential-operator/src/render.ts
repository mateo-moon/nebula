import { renderConfidentialWorkload, validateStorage, validateWorkload, ConfidentialValidationError } from "nebula-cdk8s/confidential-workloads";

function publicDeclaration(operation: () => void) {
  try { operation(); } catch (error) {
    if (error instanceof ConfidentialValidationError) throw error;
    throw new ConfidentialValidationError("Confidential workload: invalid public declaration");
  }
}

/** Fixed JSON protocol used by the Go controller. This process has no Kubernetes
 * client and never receives owner credentials. The owner CLI imports the same
 * renderer and native genpolicy implementation independently. */
export function renderRequest(input: any) {
  if (input.operation === "validate-storage") {
    publicDeclaration(() => validateStorage(input.storage));
    return {};
  }
  if (input.operation !== "render-workload") throw new Error("Unknown renderer operation");
  publicDeclaration(() => validateWorkload(input.workload, input.storages));
  const result = renderConfidentialWorkload(input.workload, input.storages, {
    publishedImageDigests: input.resolvedImageDigests, genpolicy: {
    executable: process.env.GENPOLICY ?? "/usr/local/bin/genpolicy",
    cacheDirectory: process.env.GENPOLICY_CACHE ?? "/tmp/genpolicy-cache",
  } });
  const resolvedImageDigests = Object.fromEntries(input.workload.spec.containers.filter((container: any) =>
    container.imageKeyResource && !container.image.includes("@sha256:")).map((container: any) => {
      const actual = result.pod.spec.containers.find((value: any) => value.name === container.name);
      if (!actual) throw new Error("Rendered application is missing");
      return [container.image, actual.image.split("@")[1]];
    }));
  return { pod: result.pod, specSha256: result.specSha256, initDataSha256: result.identity.initDataSha256, resolvedImageDigests };
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
