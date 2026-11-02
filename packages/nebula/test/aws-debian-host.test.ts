import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { AwsK0sProvider } from "../src/modules/infra/aws/k0s-provider";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { awsHostPreK0sCommands, validateAwsHostProfile, type AwsHostProfile } from "../src/modules/infra/aws/host-profile";
import { debianHostSetupScript, getDebianSsmArtifacts } from "../src/modules/infra/aws/debian-host/index.mjs";

function bootstrap(arch: "amd64" | "arm64", overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "debian-bootstrap-"));
  try {
    const trace = join(dir, "trace"); writeFileSync(trace, "");
    const os = join(dir, "os-release"); writeFileSync(os, "ID=debian\nVERSION_CODENAME=trixie\n");
    const binaries: Record<string, string> = {
      uname: 'printf "fixture-kernel"',
      dpkg: 'case "$1" in --print-architecture) printf "%s" "$HOST_ARCH";; --compare-versions) [ "$OLD_KERNEL" = 0 ];; --install) printf "installed\\n" >> "$TRACE";; *) exit 99;; esac',
      "dpkg-query": 'case "$*" in *linux-image-*) printf "installed 6.12.113-1";; *) exit 1;; esac',
      "apt-get": 'printf "apt\\n" >> "$TRACE"',
      curl: 'while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; touch "$1"; fi; shift; done',
      sha256sum: 'cat >/dev/null; printf "hash\\n" >> "$TRACE"; [ "$BAD_HASH" = 0 ]',
      gpg: 'case "$*" in *--with-colons*) printf "fpr:::::::::%s:\\n" "$FINGERPRINT";; *--verify*) printf "signature\\n" >> "$TRACE"; [ "$BAD_SIGNATURE" = 0 ];; esac',
      "dpkg-deb": 'case "$3" in Package) printf amazon-ssm-agent;; Version) printf "%s" "$PACKAGE_VERSION";; Architecture) printf "%s" "$PACKAGE_ARCH";; *) exit 99;; esac',
      systemctl: 'printf "ssm\\n" >> "$TRACE"',
    };
    for (const [name, body] of Object.entries(binaries)) writeFileSync(join(dir, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    const script = debianHostSetupScript({ architecture: arch, suite: "trixie", minimumKernelVersion: "6.12.113-1" })
      .replace("/etc/os-release", os).replace("/etc/apt/apt.conf.d/99-nebula-reboot-policy", join(dir, "reboot-policy"));
    assert.ok(!script.includes("@@"));
    assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
    const result = spawnSync("sh", ["-eu"], { input: script, encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, TRACE: trace,
      HOST_ARCH: arch, OLD_KERNEL: "0", BAD_HASH: "0", BAD_SIGNATURE: "0", PACKAGE_ARCH: arch,
      PACKAGE_VERSION: getDebianSsmArtifacts()[arch].packageVersion, FINGERPRINT: getDebianSsmArtifacts()[arch].signingFingerprint, ...overrides } });
    return { ...result, trace: readFileSync(trace, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("both official image architectures install only the verified management package", () => {
  for (const arch of ["amd64", "arm64"] as const) {
    const result = bootstrap(arch); assert.equal(result.status, 0, result.stderr);
    assert.match(result.trace, /hash\nhash\nhash\nsignature\ninstalled\nssm\n/);
    for (const bad of [{ BAD_HASH: "1" }, { BAD_SIGNATURE: "1" }, { FINGERPRINT: "other" },
      { PACKAGE_ARCH: "other" }, { PACKAGE_VERSION: "other" }, { HOST_ARCH: "other" }, { OLD_KERNEL: "1" }]) {
      const failed = bootstrap(arch, bad); assert.notEqual(failed.status, 0, JSON.stringify(bad));
      assert.ok(!failed.trace.includes("installed"), JSON.stringify(bad));
      assert.ok(!failed.trace.includes("ssm"), JSON.stringify(bad));
    }
  }
});
test("custom workers start management before attachment waits and keep bounded user-data", () => {
  const profile: AwsHostProfile = { architecture: "arm64", sshUser: "admin", rootDeviceName: "/dev/xvda",
    debian: { suite: "trixie", minimumKernelVersion: "6.12.113-1", requireSsmAgent: true, installSsmAgent: true } };
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", { namePrefix: "test", clusterName: "test", k0sVersion: "v1.35.7+k0s.0",
    sshPublicKey: "fixture-public-key", sshSecretName: "fixture", dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "worker", observedIdentity: true });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" },
    { name: "worker", ami: "ami-fixture", instanceType: "m6g.large", hostProfile: profile, nodeLabels: {}, dataVolume: { createFresh: true, sizeGi: 12, snapshot: false } }, "existing");
  const launchTemplate = Testing.synth(chart).find(r => r.kind === "XAwsWorkerLaunchTemplate")!.spec.launchTemplate;
  const script = Buffer.from(launchTemplate.spec.forProvider.userData, "base64");
  assert.ok(script.length < 16 * 1024, `user-data is ${script.length} bytes`);
  assert.ok(script.toString().indexOf("systemctl enable --now") < script.toString().indexOf("associate-address"));
  assert.equal(awsHostPreK0sCommands(profile).length, 2);
  const capa = Testing.chart();
  new K0smotronCluster(capa, "cluster", { name: "test", k8sVersion: "v1.35.7", provider: new AwsK0sProvider({ region: "eu-central-1" }),
    workerPools: { general: { machine: { ami: { id: "ami-fixture" }, hostProfile: profile } } } });
  assert.deepEqual(Testing.synth(capa).find(r => r.kind === "K0sWorkerConfigTemplate")!.spec.template.spec.preK0sCommands.slice(0, 2), awsHostPreK0sCommands(profile));
  assert.throws(() => validateAwsHostProfile({ ...profile, debian: { ...profile.debian!, requireSsmAgent: false } }), /requires/);
});
test("the published package includes the native API and every bootstrap verification asset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debian-package-"));
  try {
    const metadata = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, "--cache", join(dir, "cache")], { encoding: "utf8" }))[0];
    execFileSync("tar", ["-xzf", join(dir, metadata.filename), "-C", dir]);
    const root = join(dir, "package/src/modules/infra/aws/debian-host");
    for (const asset of ["setup.sh", "ssm-artifacts.json", "amazon-ssm-agent.asc", "index.d.mts"]) assert.ok(existsSync(join(root, asset)), asset);
    const module = await import(pathToFileURL(join(root, "index.mjs")).href);
    assert.match(module.debianHostSetupScript({ architecture: "amd64", suite: "trixie", minimumKernelVersion: "6.12.113-1" }), /BEGIN PGP PUBLIC KEY/);
    assert.equal(module.getDebianSsmArtifacts().arm64.packageVersion, "3.3.5700.0-1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
