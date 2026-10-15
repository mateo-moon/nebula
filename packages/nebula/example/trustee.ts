/** Render an owner-approved confidential Trustee release; no fabricated policy
 * or measurement defaults. See the module README for offline preparation. */
import { App, Chart } from "cdk8s";
import { readFileSync } from "node:fs";
import { Trustee, type TrusteeConfig } from "../src/modules/k8s/trustee";
import type { MeasuredArtifact } from "../src/modules/k8s/confidential-guests/measured";

const [configFile, artifactFile, outdir = "dist/trustee"] = process.argv.slice(2);
if (!configFile || !artifactFile) throw new Error("Usage: trustee.ts PUBLIC_CONFIG_JSON REVIEWED_ARTIFACT_JSON [OUTDIR]");
const config = JSON.parse(readFileSync(configFile, "utf8")) as TrusteeConfig;
const policy = JSON.parse(readFileSync(artifactFile, "utf8")) as MeasuredArtifact;
const app = new App({ outdir });
const chart = new Chart(app, "trustee");
new Trustee(chart, "trustee", { ...config, policy });
app.synth();
