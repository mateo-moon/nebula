import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { renderConfidentialWorkload, type ConfidentialStorageResource, type ConfidentialWorkloadResource,
  type WorkloadRenderOptions } from "nebula-cdk8s/confidential-workloads";
import { resourcePath, trusteePolicies, type TrusteeResourcePath } from "nebula-cdk8s/trustee/policies";
import { prepareClient, readPreparedClient, type PrepareClientOptions } from "./prepare";
import { readEnrollment } from "./enrollment";
import { claimSha256, readClaimToken } from "./claim";

export interface PrepareWorkloadOptions extends Omit<PrepareClientOptions, "identity" | "instanceBound"> {
  readonly manifest: string;
  readonly name: string;
  readonly genpolicy?: WorkloadRenderOptions["genpolicy"];
  readonly claimTokenFile?: string;
  readonly publishedImageDigests?: Readonly<Record<string, string>>;
}

/** Compile owner-reviewed declarations independently of the cluster. The
 * operator's status, annotations and observed report are never approval input. */
export function prepareWorkload(options: PrepareWorkloadOptions): string {
  const bytes = readFileSync(options.manifest);
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Workload declaration exceeds 2 MiB");
  const documents = parseAllDocuments(bytes.toString("utf8"));
  if (documents.some(document => document.errors.length)) throw new Error("Invalid workload YAML");
  const values = documents.map(document => document.toJS({ maxAliasCount: 0 }));
  const candidates = values.filter(value => value?.kind === "ConfidentialWorkload" && value.metadata?.name === options.name);
  if (candidates.length !== 1) throw new Error("Select exactly one ConfidentialWorkload from the reviewed declaration");
  const workload = candidates[0] as ConfidentialWorkloadResource;
  const expectedClaim = workload.spec.ownerClaimSha256;
  if (expectedClaim !== undefined) {
    if (!options.claimTokenFile) throw new Error("The private claim token is required for this workload");
    const token = readClaimToken(options.claimTokenFile);
    const actual = claimSha256(token);
    token.fill(0);
    if (actual !== expectedClaim) {
      throw new Error("The private claim token does not match the measured workload declaration");
    }
  } else if (options.claimTokenFile) throw new Error("This workload does not use first-connection claiming");
  const storages = values.filter(value => value?.kind === "ConfidentialStorage") as ConfidentialStorageResource[];
  const plan = renderConfidentialWorkload(workload, storages, {
    genpolicy: options.genpolicy, publishedImageDigests: options.publishedImageDigests,
  });
  const directory = prepareClient({ ...options, identity: plan.identity, instanceBound: true });
  writeFileSync(join(directory, "workload.json"), JSON.stringify({
    version: 1, audience: plan.audience, resources: workload.spec.resources,
    ...(expectedClaim ? { ownerClaimSha256: expectedClaim } : {}),
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return directory;
}

/** Derive policy text from the privately prepared identity and resource list.
 * No Rego is accepted from Kubernetes, or from an enrollment response. */
export function preparedWorkloadPolicies(directory: string, audience: string) {
  const prepared = readPreparedClient(directory);
  if (!prepared.profile.instanceBound) throw new Error("Workload configuration requires instance-bound state");
  readEnrollment(directory, audience);
  const path = join(prepared.directory, "workload.json"), stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error("Invalid private workload approval");
  const approval = JSON.parse(readFileSync(path, "utf8")) as {
    version: number; audience: string; resources: TrusteeResourcePath[]; ownerClaimSha256?: string;
  };
  if (Object.keys(approval).sort().join() !==
      (approval.ownerClaimSha256 ? "audience,ownerClaimSha256,resources,version" : "audience,resources,version") ||
      approval.version !== 1 || approval.audience !== audience || !Array.isArray(approval.resources)) {
    throw new Error("Workload approval does not match the enrolled audience");
  }
  approval.resources.forEach(resourcePath);
  return trusteePolicies(approval.resources.map(path => ({ path, recipients: [prepared.profile.identity] })));
}
