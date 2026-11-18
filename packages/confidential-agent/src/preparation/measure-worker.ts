import { parentPort, workerData } from "node:worker_threads";
import { renderConfidentialWorkload } from "nebula-cdk8s/confidential-workloads";

if (!parentPort) throw new Error("Native policy calculation requires its worker");
const { connection, manifest, config, digest, cacheDirectory } = workerData;
const destination = connection.workload.spec.containers[0].image;
const { identity, policies, audience, specSha256 } = renderConfidentialWorkload(connection.workload, connection.storages, {
  genpolicy: { executable: "/usr/local/bin/genpolicy", cacheDirectory },
  publishedImageDigests: { [destination]: digest },
  publishedImageConfigs: { [destination]: { manifest: Buffer.from(manifest), config: Buffer.from(config) } },
});
parentPort.postMessage({ identity, policies, audience, specSha256 });
