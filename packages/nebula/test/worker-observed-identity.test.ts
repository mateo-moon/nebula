import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import { AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { AwsWorkerLaunchTemplateSetup, WORKER_LAUNCH_TEMPLATE } from "../src/modules/infra/aws/worker-launch-template";

const dir = mkdtempSync(join(tmpdir(), "worker-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, fileURLToPath(new URL("./support/worker-template/main.go", import.meta.url))],
  { env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-worker-go-cache"), GOTOOLCHAIN: "local", GOPROXY: "off" }, timeout: 120000 });
after(() => rmSync(dir, { recursive: true, force: true }));

function manifests(dataVolume: "existing" | "fresh" | "none" = "existing") {
  const chart = Testing.chart();
  new AwsWorkerLaunchTemplateSetup(chart, "setup");
  const fleet = new AwsWorkerFleet(chart, "fleet", {
    namePrefix: "test", clusterName: "test", k0sVersion: "v1.36.3+k0s.2", observedIdentity: true,
    sshPublicKey: "fixture-public-key", sshSecretName: "test-ssh",
    dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "test-worker",
  });
  fleet.addEip("test-node", "eu-central-1", { existing: true, retain: true });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a",
    vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" }, {
    name: "test-node", ami: "ami-fixture", instanceType: "m6i.xlarge", nodeLabels: {},
    ...(dataVolume === "none" ? {} : { dataVolume: { sizeGi: 100,
      ...(dataVolume === "existing" ? { existing: true as const } : { createFresh: true as const }) } }),
  }, "test-profile");
  return Testing.synth(chart);
}
const resources = manifests();
const xr = resources.find(r => r.kind === "XAwsWorkerLaunchTemplate")!;
const eip = { resource: { status: { atProvider: { manifest: {
  metadata: { name: "test-node", annotations: { "crossplane.io/external-name": "eipalloc-0123456789abcdef0" } },
  spec: { forProvider: { region: "eu-central-1" } },
  status: { atProvider: { id: "eipalloc-0123456789abcdef0", allocationId: "eipalloc-0123456789abcdef0", region: "eu-central-1" } },
} } } } };
const volume = { resource: { status: { atProvider: { manifest: {
  metadata: { name: "test-node-data", annotations: { "crossplane.io/external-name": "vol-0123456789abcdef0" } },
  spec: { forProvider: { region: "eu-central-1", availabilityZone: "eu-central-1a" } },
  status: { atProvider: { id: "vol-0123456789abcdef0", region: "eu-central-1", availabilityZone: "eu-central-1a" } },
} } } } };
function render(observed: Record<string, any>, composite = xr) {
  const out = execFileSync(binary, [], { input: JSON.stringify({ template: WORKER_LAUNCH_TEMPLATE,
    data: { observed: { composite: { resource: composite }, resources: observed } } }), encoding: "utf8" });
  return out.split(/^---$/m).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}
const templateOf = (objects: any[]) => objects.find(r => r.kind === "LaunchTemplate");

test("observed workers declare no cloud IDs, and retained disks/addresses cannot recreate or delete", () => {
  assert.ok(!resources.some(r => r.kind === "LaunchTemplate"));
  for (const resource of resources.filter(r => ["EIP", "EBSVolume"].includes(r.kind))) {
    assert.equal(resource.metadata.annotations?.["crossplane.io/external-name"], undefined);
    assert.equal(resource.spec.deletionPolicy, "Orphan");
    assert.ok(!resource.spec.managementPolicies.includes("Create"));
    assert.ok(!resource.spec.managementPolicies.includes("Delete"));
  }
  const group = resources.find(r => r.kind === "AutoscalingGroup")!;
  assert.deepEqual(group.spec.forProvider.launchTemplate, [{ name: "test-node", version: "$Latest" }]);
  const fresh = manifests("fresh").find(r => r.kind === "EBSVolume")!;
  assert.ok(fresh.spec.managementPolicies.includes("Create"));
  assert.ok(!fresh.spec.managementPolicies.includes("Delete"));
});

test("missing, empty, wrong-name and wrong-zone observations cannot create a template", () => {
  for (const observed of [{}, { eip }, { "data-volume": volume }, { eip: { resource: {} }, "data-volume": volume }])
    assert.equal(templateOf(render(observed)), undefined);
  for (const invalid of ["", "vol-bad;touch /tmp/unwanted"] ) {
    const wrong = structuredClone(volume);
    wrong.resource.status.atProvider.manifest.status.atProvider.id = invalid;
    assert.equal(templateOf(render({ eip, "data-volume": wrong })), undefined);
  }
  for (const mismatch of ["name", "zone", "region"]) {
    const wrong = structuredClone(volume);
    const manifest = wrong.resource.status.atProvider.manifest;
    if (mismatch === "name") manifest.metadata.name = "other-volume";
    if (mismatch === "zone") manifest.spec.forProvider.availabilityZone = "eu-central-1b";
    if (mismatch === "region") manifest.spec.forProvider.region = "us-east-1";
    assert.equal(templateOf(render({ eip, "data-volume": wrong })), undefined);
  }
});

test("stale status cannot override a changed resource binding or observed location", () => {
  for (const kind of ["eip", "data-volume"] as const) {
    for (const mismatch of ["binding", "region", "provider-identity"]) {
      const observed = structuredClone({ eip, "data-volume": volume });
      const manifest: any = observed[kind].resource.status.atProvider.manifest;
      if (mismatch === "binding") manifest.metadata.annotations["crossplane.io/external-name"] = "changed";
      if (mismatch === "region") manifest.status.atProvider.region = "us-east-1";
      if (mismatch === "provider-identity") {
        if (kind === "eip") manifest.status.atProvider.allocationId = "eipalloc-deadbeef";
        else manifest.status.atProvider.availabilityZone = "eu-central-1b";
      }
      assert.equal(templateOf(render(observed)), undefined);
    }
  }
});

test("restored status without retained external bindings cannot create replacement workers", () => {
  const restored = structuredClone({ eip, "data-volume": volume });
  delete (restored.eip.resource.status.atProvider.manifest.metadata as any).annotations;
  delete (restored["data-volume"].resource.status.atProvider.manifest.metadata as any).annotations;
  assert.equal(templateOf(render(restored)), undefined);
  assert.equal(templateOf(render({})), undefined);
  for (const resource of resources.filter(resource => ["EIP", "EBSVolume"].includes(resource.kind))) {
    assert.equal(resource.spec.deletionPolicy, "Orphan");
    assert.ok(!resource.spec.managementPolicies.some((policy: string) => ["Create", "Delete"].includes(policy)));
  }
  assert.ok(templateOf(render({ eip, "data-volume": volume })), "valid restored bindings can resume composition");
});

test("valid observations produce the named LT with the exact IDs and attachment confirmation", () => {
  const result = render({ eip, "data-volume": volume });
  const template = templateOf(result)!;
  assert.equal(template.metadata.name, "test-node");
  const script = Buffer.from(template.spec.forProvider.userData, "base64").toString();
  assert.ok(script.includes("--allocation-id eipalloc-0123456789abcdef0"));
  assert.ok(script.includes("--volume-ids vol-0123456789abcdef0"));
  assert.ok(script.includes('= "attached" ] && break'));
  assert.ok(script.includes('DeleteOnTermination\\\":false'));
  assert.ok(!script.includes("__NEBULA_"));
  for (const observation of result.filter(r => r.kind === "Object"))
    assert.deepEqual(observation.spec.managementPolicies, ["Observe"]);
});

test("retained storage selects only the observed EBS serial and never initializes an unexpected disk", () => {
  const previous = templateOf(render({ eip, "data-volume": volume }))!;
  const script = Buffer.from(previous.spec.forProvider.userData, "base64").toString();
  const lvm = script.slice(script.indexOf("\nROOT_PART="), script.indexOf("\n# Grow only"));
  for (const mode of ["existing", "wrong-group", "missing", "ambiguous", "root", "spanning"]) {
    const calls = join(dir, `lvm-${mode}`);
    const command = `
findmnt() { printf /dev/rootpart; }
sleep() { :; }
lsblk() {
  if [ "$1" = -no ]; then printf rootdisk; return; fi
  case "$MODE" in
    missing) printf '/dev/unrelated volfedcba\\n';;
    ambiguous) printf '/dev/data vol0123456789abcdef0\\n/dev/other vol0123456789abcdef0\\n';;
    root) printf '/dev/rootdisk vol0123456789abcdef0\\n';;
    *) printf '/dev/unrelated volfedcba\\n/dev/data vol0123456789abcdef0\\n';;
  esac
}
pvs() { [ "$MODE" = wrong-group ] && printf another-vg || printf test-vg; }
vgs() { [ "$MODE" = spanning ] && printf 2 || printf 1; }
vgchange() { printf '%s\\n' "$*" >> "$CALLS"; }
pvcreate() { printf destructive >> "$CALLS"; exit 97; }
vgcreate() { printf destructive >> "$CALLS"; exit 98; }
${lvm}
`;
    const result = spawnSync("bash", ["-ec", command], { encoding: "utf8",
      env: { ...process.env, MODE: mode, CALLS: calls }, timeout: 5000 });
    assert.equal(result.status, mode === "existing" ? 0 : 1, `${mode}: ${result.stderr}`);
    if (mode === "existing") assert.equal(readFileSync(calls, "utf8"), "-ay test-vg\n");
  }
});

test("transient observation loss preserves the existing template to prevent resource garbage collection", () => {
  const previous = templateOf(render({ eip, "data-volume": volume }))!;
  const recovered = templateOf(render({ "launch-template": { resource: previous } }));
  assert.deepEqual(recovered, previous);
});

test("boot confirms the data attachment and disables deletion on instance termination", () => {
  const script = Buffer.from(templateOf(render({ eip, "data-volume": volume }))!.spec.forProvider.userData, "base64").toString();
  const assembly = script.slice(script.indexOf("\nTOKEN="), script.indexOf("\nROOT_PART="));
  for (const device of ["/dev/sdf", "/dev/sda1"]) {
    const result = spawnSync("bash", ["-ec", `
retry() { "$@"; }
curl() { case "$*" in *instance-id*) printf i-current;; *) printf token;; esac; }
aws() {
  case "$2" in
    associate-address) :;;
    describe-volumes) case "$*" in *.Device*) printf '%s' "$DEVICE";; *) printf attached;; esac;;
    modify-instance-attribute)
      if [ "$7" = --block-device-mappings ]; then printf '%s' "$8"; fi;;
    *) exit 99;;
  esac
}
${assembly}
`], { env: { ...process.env, DEVICE: device }, encoding: "utf8", timeout: 5000 });
    if (device === "/dev/sdf") {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [{ DeviceName: device, Ebs: { DeleteOnTermination: false } }]);
    } else {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    }
  }
});

test("workers without data volumes require only the named EIP", () => {
  const diskless = manifests("none").find(r => r.kind === "XAwsWorkerLaunchTemplate")!;
  const result = render({ eip }, diskless);
  assert.equal(result.filter(r => r.kind === "Object").length, 1);
  const script = Buffer.from(templateOf(result)!.spec.forProvider.userData, "base64").toString();
  assert.ok(!script.includes("attach-volume"));
});
