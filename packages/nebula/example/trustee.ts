/** Native policy generation is part of synthesis; input contains public configuration only. */
import { App, Chart } from "cdk8s";
import { readFileSync } from "node:fs";
import { Trustee, type TrusteeConfig } from "../src/modules/k8s/trustee";

const [configFile, outdir = "dist/trustee"] = process.argv.slice(2);
if (!configFile) throw new Error("Usage: trustee.ts PUBLIC_CONFIG_JSON [OUTDIR]");
const config = JSON.parse(readFileSync(configFile, "utf8")) as TrusteeConfig;
const app = new App({ outdir });
const chart = new Chart(app, "trustee");
const trustee = new Trustee(chart, "trustee", config);
app.synth();
// In a combined owner application, pass trustee.identity directly to prepareClient().
// This is public verification output, never an input to deployment synthesis.
console.log(JSON.stringify({ serviceUrl: trustee.serviceUrl, identity: trustee.identity }));
