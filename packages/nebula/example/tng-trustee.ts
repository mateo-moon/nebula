import { App, Chart } from "cdk8s";
import { readFileSync } from "node:fs";
import { TngTrustee, type TngTrusteeConfig } from "../src/modules/k8s/trustee";
import type { MeasuredArtifact } from "../src/modules/k8s/confidential-guests/measured";

const [configPath, artifactPath, outdir = "dist/tng-trustee"] = process.argv.slice(2);
if (!configPath || !artifactPath) throw new Error("Usage: tng-trustee.ts PUBLIC_CONFIG REVIEWED_ARTIFACT [OUTDIR]");
const config = JSON.parse(readFileSync(configPath, "utf8")) as TngTrusteeConfig;
const policy = JSON.parse(readFileSync(artifactPath, "utf8")) as MeasuredArtifact;
const app = new App({ outdir }), chart = new Chart(app, "tng-trustee");
new TngTrustee(chart, "trustee", { ...config, policy });
app.synth();
