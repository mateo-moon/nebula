/** Offline preparation only. Inputs contain public deployment metadata, never
 * resource values or TLS private keys. Nothing is applied to a cluster/KBS. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trusteePlan, trusteeInitData, trusteeBootstrapPolicies, type TrusteeConfig,
  type TrusteeSnpIdentity } from "../src/modules/k8s/trustee";
import type { MeasuredArtifact } from "../src/modules/k8s/confidential-guests/measured";

const [mode, configFile, ...args] = process.argv.slice(2);
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
if (!configFile || !["template", "bind", "bootstrap-policies"].includes(mode)) {
  throw new Error("Usage: prepare-trustee.ts template CONFIG OUTDIR | bind CONFIG PREPARATION REVIEWED_REGO ARTIFACT | bootstrap-policies CONFIG ARTIFACT SNP_APPROVAL OUTDIR");
}
const config = json<TrusteeConfig>(configFile);
if (mode === "template") {
  if (args.length !== 1) throw new Error("template requires OUTDIR");
  const plan = trusteePlan(config);
  mkdirSync(args[0], { recursive: true });
  save(join(args[0], "deployment.json"), plan.workload);
  save(join(args[0], "preparation.json"), { canonicalPodSha256: plan.canonicalPodSha256 });
  writeFileSync(join(args[0], "resource-policy.rego"), plan.resourcePolicy);
  writeFileSync(join(args[0], "attestation-policy.rego"), plan.attestationPolicy);
} else if (mode === "bind") {
  if (args.length !== 3) throw new Error("bind requires PREPARATION REVIEWED_REGO ARTIFACT");
  const preparation = json<{ canonicalPodSha256: string }>(args[0]);
  save(args[2], trusteeInitData(config, { canonicalPodSha256: preparation.canonicalPodSha256,
    policyRego: readFileSync(args[1], "utf8") }));
} else {
  if (args.length !== 3) throw new Error("bootstrap-policies requires ARTIFACT SNP_APPROVAL OUTDIR");
  const policies = trusteeBootstrapPolicies(config, json<MeasuredArtifact>(args[0]),
    json<Omit<TrusteeSnpIdentity, "initDataSha256">>(args[1]));
  mkdirSync(args[2], { recursive: true });
  writeFileSync(join(args[2], "resource-policy.rego"), policies.resourcePolicy);
  writeFileSync(join(args[2], "attestation-policy.rego"), policies.attestationPolicy);
}
