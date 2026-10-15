/** Offline preparation of measured public server configuration.
 * Client preparation and provisioning live in @nebula/trustee-client. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tngTrusteePlan, tngTrusteeInitData, type TngTrusteeConfig } from "../src/modules/k8s/trustee";

const [mode, input, ...args] = process.argv.slice(2);
const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
if (mode === "template" && input && args.length === 1) {
  const plan = tngTrusteePlan(load<TngTrusteeConfig>(input));
  mkdirSync(args[0], { recursive: true, mode: 0o700 });
  save(join(args[0], "deployment.json"), plan.workload);
  save(join(args[0], "preparation.json"), { canonicalPodSha256: plan.canonicalPodSha256 });
} else if (mode === "bind" && input && args.length === 3) {
  const prepared = load<{ canonicalPodSha256: string }>(args[0]);
  save(args[2], tngTrusteeInitData(load<TngTrusteeConfig>(input), {
    canonicalPodSha256: prepared.canonicalPodSha256, policyRego: readFileSync(args[1], "utf8") }));
} else {
  throw new Error("Usage: prepare-tng-trustee.ts template PUBLIC_CONFIG OUTDIR | bind PUBLIC_CONFIG PREPARATION REVIEWED_REGO ARTIFACT");
}
