import { Worker } from "node:worker_threads";
import type { renderConfidentialWorkload } from "nebula-cdk8s/confidential-workloads";
import type { PublicConnection } from "./publish";

type Measurement = Pick<ReturnType<typeof renderConfidentialWorkload>, "identity" | "policies" | "audience" | "specSha256">;

/** Native synthesis is synchronous. Keep it off the server's event loop so
 * fresh SNP evidence and owner requests remain available during calculation. */
export function measure(connection: PublicConnection, manifest: Buffer, config: Buffer,
  digest: string, cacheDirectory: string, dockerConfig: string): Promise<Measurement> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./measure-worker.mjs", import.meta.url), {
      workerData: { connection, manifest, config, digest, cacheDirectory },
      env: { ...process.env, DOCKER_CONFIG: dockerConfig },
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Native policy calculation timed out")); }, 660_000);
    worker.once("message", result => { clearTimeout(timer); resolve(result as Measurement); void worker.terminate(); });
    worker.once("error", error => { clearTimeout(timer); reject(new Error(error.message.slice(0, 2048))); });
    worker.once("exit", () => { clearTimeout(timer); reject(new Error("Native policy worker stopped without a result")); });
  });
}
