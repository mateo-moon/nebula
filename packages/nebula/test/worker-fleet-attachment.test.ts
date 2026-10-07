import assert from "node:assert/strict";
import { test } from "node:test";
import { Testing } from "cdk8s";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";

const chart = Testing.chart();
const fleet = new AwsWorkerFleet(chart, "fleet", {
  namePrefix: "test", clusterName: "test", k0sVersion: "v1.36.3+k0s.2",
  sshPublicKey: "fixture-public-key", sshSecretName: "test-ssh",
  dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "test-worker",
});
fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a",
  vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" }, {
  name: "test-node", ami: "ami-fixture", instanceType: "m6i.xlarge",
  allocationId: "eipalloc-fixture", nodeLabels: {},
  dataVolume: { sizeGi: 100, volumeId: "vol-fixture", snapshot: false },
}, "test-profile");
const template = Testing.synth(chart).find(r => r.kind === "LaunchTemplate")!;
const userData = Buffer.from(template.spec.forProvider.userData, "base64").toString();
// Execute the rendered self-assembly shell, stopping before any LVM operation.
const assembly = userData.slice(userData.indexOf("\nTOKEN="), userData.indexOf("\nROOT_PART="));
assert.ok(assembly.includes("describe-volumes"));

function simulate(states: string[], failAttach = false): string[] {
  const dir = mkdtempSync(join(tmpdir(), "nebula-volume-attachment-"));
  try {
    writeFileSync(join(dir, "states"), states.join("\n") + "\n");
    const result = spawnSync("bash", ["-e", "-c", `
retry() { "$@"; }
curl() { case "$*" in *instance-id*) printf i-current;; *) printf fixture-token;; esac; }
sleep() {
  printf 'wait\\n' >> "$TEST_DIR/calls"
  waits=$((waits+1))
  [ "$waits" -le ${states.length + 1} ] || exit 90
}
aws() {
  printf '%s\\n' "$2" >> "$TEST_DIR/calls"
  case "$2" in
    associate-address|modify-instance-attribute) return 0;;
    describe-volumes)
      # Ownership must be queried for the actual IMDS instance, not any attachment.
      [[ "$*" == *"Attachments[?InstanceId=='i-current'].State | [0]"* ]] || return 91
      [[ "$*" == *"--volume-ids vol-fixture"* ]] || return 92
      state=$(head -1 "$TEST_DIR/states")
      tail -n +2 "$TEST_DIR/states" > "$TEST_DIR/next"
      mv "$TEST_DIR/next" "$TEST_DIR/states"
      [ -n "$state" ] || return 93
      [ "$state" != error ] || return 1
      printf '%s\\n' "$state";;
    attach-volume)
      [[ "$*" == *"--instance-id i-current --volume-id vol-fixture --device /dev/sdf"* ]] || return 94
      ${failAttach ? "return 1" : "printf attaching"};;
    *) return 95;;
  esac
}
waits=0
${assembly}
printf 'ready\\n' >> "$TEST_DIR/calls"
`], { env: { ...process.env, TEST_DIR: dir }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").slice(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a disk already attached to this VM completes without another attach request", () => {
  assert.deepEqual(simulate(["attached"]), ["describe-volumes", "ready"]);
});

test("an in-progress attachment waits until attached instead of repeating the request", () => {
  assert.deepEqual(simulate(["attaching", "attached"]),
    ["describe-volumes", "wait", "describe-volumes", "ready"]);
});

test("a successful attach request still waits for confirmed ownership", () => {
  assert.deepEqual(simulate(["None", "attaching", "attached"]),
    ["describe-volumes", "attach-volume", "wait", "describe-volumes", "wait", "describe-volumes", "ready"]);
});

test("a predecessor's attachment cannot release startup after VolumeInUse", () => {
  assert.deepEqual(simulate(["None", "None", "attached"], true),
    ["describe-volumes", "attach-volume", "wait", "describe-volumes", "attach-volume", "wait", "describe-volumes", "ready"]);
});

test("an observation failure cannot trigger an attachment or release startup", () => {
  assert.deepEqual(simulate(["error", "attached"]),
    ["describe-volumes", "wait", "describe-volumes", "ready"]);
});

test("a detaching volume waits for a new attachment before continuing", () => {
  assert.deepEqual(simulate(["detaching", "None", "attached"]),
    ["describe-volumes", "wait", "describe-volumes", "attach-volume", "wait", "describe-volumes", "ready"]);
});
