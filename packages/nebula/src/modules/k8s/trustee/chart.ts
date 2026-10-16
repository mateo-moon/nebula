import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Upstream distributes this chart in Git, without a published Helm repository.
// Resolve that dependency during synthesis; never ship or modify its templates.
export const TRUSTEE_CHART_SOURCE = "3e160008ef3e5d8ce82e59c729d56e2d0175dba0";
export const TRUSTEE_CHART_SHA256 = "5118ffa64c2376db52b4524719ffe8d0fafa1d91b8bd5a47340e4deb7b34dd06";
const dependencies = {
  "postgresql-18.2.0.tgz": "3d1ab83b00ce9da2fcd55d66ab5b09aac1baef1fe099f52edc73860372cdcc63",
  "valkey-6.2.0.tgz": "72da4e974317fc5f98de3f9085fba56ab5d200d1a2c585423ca0612ad9c2378e",
};

function verify(path: string, expected: string): void {
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== expected) {
    throw new Error("Trustee: official chart dependency checksum mismatch");
  }
}

/** cdk8s renders synchronously. Keep the dependency private and temporary, and
 * remove it on success or failure; no chart preparation or build step for users. */
export function withTrusteeChart<T>(render: (chart: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "nebula-trustee-chart-"));
  try {
    const archive = join(directory, "source.tar.gz");
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https",
      "--proto-redir", "=https", "--max-time", "60", "--retry", "2", "--output", archive,
      `https://github.com/confidential-containers/trustee/archive/${TRUSTEE_CHART_SOURCE}.tar.gz`],
      { timeout: 180_000, stdio: "pipe" });
    verify(archive, TRUSTEE_CHART_SHA256);
    const path = `trustee-${TRUSTEE_CHART_SOURCE}/deployment/helm-chart`;
    execFileSync("tar", ["-xzf", archive, "-C", directory, path], { timeout: 30_000, stdio: "pipe" });
    const chart = join(directory, path);
    // Helm requires the locked optional subcharts even when both are disabled.
    execFileSync("helm", ["dependency", "build", chart, "--skip-refresh"], { timeout: 180_000, stdio: "pipe" });
    for (const [name, checksum] of Object.entries(dependencies)) verify(join(chart, "charts", name), checksum);
    return render(chart);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
