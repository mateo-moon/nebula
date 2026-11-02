import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { baseBuildInput, buildDebianImage, prepareDebianImageBuild, validateDebianImageBuildConfig,
  debianImageBuildFiles, debianImageToolchain, debianSsmArtifacts, type DebianImageBuildConfig } from "../src/modules/infra/aws/debian-image/index.mjs";
import { main } from "../src/modules/infra/aws/debian-image/cli.mjs";

const config = (): DebianImageBuildConfig => ({ schema: 1, region: "eu-central-1", awsAccountId: "123456789012", minimumKernelVersion: "6.12.113-1",
  parents: { arm64: { id: "ami-0123456789abcdef0", owner: "136693071363", build: "20261026-2643" },
    amd64: { id: "ami-0123456789abcdef1", owner: "136693071363", build: "20261026-2643" } },
  spending: { enabled: false, approvalReference: null, oneTimeLimitUsd: 25, additionalImageStorageMonthlyLimitUsd: 10 } });
const metadata = (arch = "arm64") => ({ Images: [{ ImageId: config().parents[arch as "arm64" | "amd64"]!.id, OwnerId: "136693071363",
  Architecture: arch === "amd64" ? "x86_64" : "arm64", State: "available", VirtualizationType: "hvm", RootDeviceType: "ebs", EnaSupport: true,
  RootDeviceName: "/dev/xvda", BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-0123456789abcdef0" } }] }] });

test("both Debian architectures use actual parent metadata and the verified packaged SSM artifacts", () => {
  for (const arch of ["amd64", "arm64"] as const) {
    const input = baseBuildInput(arch, metadata(arch), config());
    assert.equal(input.architecture, arch); assert.equal(input.rootDeviceName, "/dev/xvda"); assert.equal(input.sshUser, "admin");
    assert.equal(input.ssm.packageVersion, "3.3.5700.0-1"); assert.equal(input.ssm.sha256, debianSsmArtifacts[arch].sha256);
  }
  const source = metadata().Images[0];
  for (const change of [{ OwnerId: "000000000000" }, { Architecture: "x86_64" }, { ImageId: "ami-11111111111111111" },
    { State: "pending" }, { RootDeviceName: "/dev/sdf" }, { EnaSupport: false }, { BlockDeviceMappings: [] }])
    assert.throws(() => baseBuildInput("arm64", { Images: [{ ...source, ...change }] }, config()), /does not match/);
});
test("disabled or incomplete approval stops before tools, AWS or Packer", () => {
  const c = config();
  const dependencies = { aws: () => assert.fail("AWS cannot run"), exec: () => assert.fail("No tool or installer may run") };
  const options = { architecture: "arm64" as const, outputDir: "/unused", vpcId: "vpc-1234", publicSubnetId: "subnet-1234", installTools: true };
  assert.throws(() => buildDebianImage(c, options, dependencies), /disabled/);
  assert.throws(() => prepareDebianImageBuild(c, { ...options, forBuild: true }, dependencies), /disabled/);
  c.spending.enabled = true;
  assert.throws(() => buildDebianImage(c, options, dependencies), /approval reference/);
  for (const change of [{ minimumKernelVersion: "6.12.112-1" }, { awsAccountId: "bad" }, { region: "bad" }])
    assert.throws(() => validateDebianImageBuildConfig({ ...config(), ...change }));
});
test("preflight binds the caller account before describing a parent and writes only public inputs", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "debian-preflight-"));
  try {
    const calls: string[][] = [];
    const result = prepareDebianImageBuild(config(), { architecture: "arm64", outputDir }, { aws: args => {
      calls.push(args); return args[0] === "sts" ? { Account: "123456789012" } : metadata();
    } });
    assert.equal(calls.length, 2); assert.equal(calls[0][0], "sts");
    assert.ok(calls[1].includes("136693071363"));
    assert.deepEqual(JSON.parse(readFileSync(result.inputFile, "utf8")), result.input);
    assert.equal("roles" in result.input, false); assert.equal("credentials" in result.input, false);
    let count = 0;
    assert.throws(() => prepareDebianImageBuild(config(), { architecture: "arm64", outputDir }, { aws: () => { count++; return { Account: "000000000000" }; } }), /caller account/);
    assert.equal(count, 1);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
test("the shared build runner uses bundled recipes and caller-owned outputs, with arguments kept separate", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "debian build with spaces-"));
  try {
    const c = config(); c.spending.enabled = true; c.spending.approvalReference = "fixture-approved";
    const calls: { command: string; args: string[] }[] = [];
    const result = buildDebianImage(c, { architecture: "arm64", outputDir, vpcId: "vpc-1234", publicSubnetId: "subnet-1234", installTools: true }, {
      aws: args => args[0] === "sts" ? { Account: c.awsAccountId } : metadata(),
      exec: (command, args) => { calls.push({ command, args }); return command === "packer" && args[0] === "version" ? `Packer v${debianImageToolchain.packerVersion}\n` : ""; },
    });
    assert.equal(calls[0].command, "bash"); assert.match(calls[0].args[0], /debian-image\/install-tools.sh$/);
    assert.deepEqual(calls.slice(1).map(x => x.args[0]), ["version", "init", "build"]);
    const build = calls.at(-1)!;
    assert.ok(build.args.includes(`output_dir=${outputDir}`)); assert.ok(build.args.includes(`input_file=${result.inputFile}`));
    assert.equal(result.manifestFile, join(outputDir, "manifest.json"));
    assert.ok(!calls.some(x => x.command === "sh" || x.args.includes("-c")));
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
test("the native CLI keeps build activation explicit", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "debian-cli-"));
  try {
    const path = join(outputDir, "config.json"); writeFileSync(path, JSON.stringify(config()));
    assert.throws(() => main(["--config", path, "--architecture", "arm64", "--output-dir", outputDir, "--build"], {
      exec: () => assert.fail("no tools"), aws: () => assert.fail("no AWS"),
    }), /disabled/);
    assert.throws(() => main(["--config", path, "--architecture", "arm64", "--output-dir", outputDir, "--install-tools"]), /requires --build/);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
test("a real packed Nebula package exposes the builder and includes all recipe and verification assets", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "debian-package-"));
  try {
    const pkg = fileURLToPath(new URL("../", import.meta.url));
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(outputDir, "npm-cache"), "--pack-destination", outputDir], { cwd: pkg, encoding: "utf8" }))[0];
    const install = join(outputDir, "node_modules/nebula-cdk8s"); mkdirSync(install, { recursive: true });
    execFileSync("tar", ["-xf", join(outputDir, packed.filename), "-C", install, "--strip-components=1"]);
    for (const file of [...Object.keys(debianImageBuildFiles()), "ssm-artifacts.json", "index.mjs", "index.d.mts", "cli.mjs"]) {
      assert.ok(packed.files.some((x: any) => x.path === `src/modules/infra/aws/debian-image/${file}`), file);
    }
    const code = `import { baseBuildInput, debianImageBuildFiles } from 'nebula-cdk8s/aws/debian-image'; import {main} from 'nebula-cdk8s/aws/debian-image/cli'; const result=baseBuildInput('arm64',JSON.parse(process.argv[2]),JSON.parse(process.argv[1])); if(result.sshUser!=='admin'||typeof main!=='function')process.exit(1); console.log(Object.keys(debianImageBuildFiles()).length);`;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(config()), JSON.stringify(metadata())], { cwd: outputDir, encoding: "utf8" }).trim(), "5");
    const link = join(outputDir, "linked-package"); symlinkSync(install, link, "dir");
    const request = join(outputDir, "disabled-config.json"); writeFileSync(request, JSON.stringify(config()));
    const cli = spawnSync(process.execPath, [join(link, "src/modules/infra/aws/debian-image/cli.mjs"), "--config", request,
      "--architecture", "arm64", "--output-dir", outputDir, "--build"], { cwd: outputDir, encoding: "utf8" });
    assert.notEqual(cli.status, 0, "a package-manager symlink must execute the CLI rather than silently skip it");
    assert.match(cli.stderr, /disabled pending cost approval/);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
