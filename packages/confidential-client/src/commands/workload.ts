import { prepareWorkload, preparedWorkloadPolicies } from "../workload";
import type { PrepareOptions } from "./prepare";
import { withClient, type ConnectionOptions } from "./shared";

export interface WorkloadOptions extends Omit<PrepareOptions, "identity" | "instanceBound"> {
  name: string;
  genpolicy?: string;
  cache?: string;
  claimToken?: string;
  accessToken?: string;
}

export function prepareWorkloadCommand(manifest: string, options: WorkloadOptions): void {
  const { host } = options;
  prepareWorkload({
    manifest, name: options.name, stateDirectory: options.state,
    target: { host, port: options.port },
    localPort: options.localPort, verifierPort: options.verifierPort, vcekFile: options.vcek,
    genpolicy: { executable: options.genpolicy, cacheDirectory: options.cache },
    claimTokenFile: options.claimToken,
    accessToken: options.accessToken,
  });
  console.log("Prepared independent workload approval. Enroll the selected instance before provisioning.");
}

export async function configureWorkload(options: ConnectionOptions): Promise<void> {
  const policies = preparedWorkloadPolicies(options.state, options.audience);
  await withClient(options, async client => {
    // The resource policy stays deny-all until the exact appraisal is present.
    await client.setAttestationPolicy(policies.attestationPolicy);
    await client.setResourcePolicy(policies.resourcePolicy);
  });
  console.log("Installed the approved guest-local resource policy on the enrolled instance.");
}

export async function storageStatus(options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => { console.log(JSON.stringify(await client.storageStatus())); });
}

export async function bootstrapStatus(options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => { console.log(JSON.stringify(await client.bootstrapStatus())); });
}
