import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import { AWS_METADATA_NODE_IP_DISCOVERY_COMMANDS, AwsWorkerFleet } from "../src/modules/infra/aws/worker-fleet";
import { AwsWorkerLaunchTemplateSetup, WORKER_LAUNCH_TEMPLATE } from "../src/modules/infra/aws/worker-launch-template";

const dir = mkdtempSync(join(tmpdir(), "worker-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."],
  { cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
    env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-worker-go-cache"), GOTOOLCHAIN: "local", GOPROXY: "off" }, timeout: 120000 });
after(() => rmSync(dir, { recursive: true, force: true }));

function manifests(dataVolume: "existing" | "fresh" | "none" = "existing", preK0sCommands?: readonly string[]) {
  const chart = Testing.chart();
  new AwsWorkerLaunchTemplateSetup(chart, "setup");
  const fleet = new AwsWorkerFleet(chart, "fleet", {
    namePrefix: "test", clusterName: "test", k0sVersion: "v1.36.3+k0s.2", observedIdentity: true,
    sshPublicKey: "fixture-public-key", sshSecretName: "test-ssh",
    dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "test-worker",
    preK0sCommands,
  });
  fleet.addEip("test-node", "eu-central-1", { existing: true, retain: true });
  fleet.addNode({ geo: "eu", region: "eu-central-1", az: "eu-central-1a",
    vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" }, {
    name: "test-node", ami: "ami-fixture", instanceType: "m6i.xlarge", nodeLabels: {},
    ...(dataVolume === "none" ? {} : { dataVolume: { sizeGi: 100, snapshot: false,
      ...(dataVolume === "existing" ? { existing: true as const } : { createFresh: true as const }) } }),
  }, "test-profile");
  return Testing.synth(chart);
}
const resources = manifests();
const xr = resources.find(r => r.kind === "XAwsWorkerLaunchTemplate")!;
xr.metadata.uid = "worker-xr-uid";
const conditions = [{ type: "Ready", status: "True" }, { type: "Synced", status: "True" }];
const eip = { resource: { status: { atProvider: { manifest: {
  metadata: { name: "test-node", annotations: { "crossplane.io/external-name": "eipalloc-0123456789abcdef0" } },
  spec: { providerConfigRef: { name: "default" }, forProvider: { region: "eu-central-1" } },
  status: { atProvider: { id: "eipalloc-0123456789abcdef0", allocationId: "eipalloc-0123456789abcdef0", region: "eu-central-1" } },
} } } } };
const volume = { resource: { status: { atProvider: { manifest: {
  metadata: { name: "test-node-data", annotations: { "crossplane.io/external-name": "vol-0123456789abcdef0" } },
  spec: { providerConfigRef: { name: "default" }, forProvider: { region: "eu-central-1", availabilityZone: "eu-central-1a" } },
  status: { atProvider: { id: "vol-0123456789abcdef0", region: "eu-central-1", availabilityZone: "eu-central-1a" } },
} } } } };
for (const observer of [eip, volume]) {
  Object.assign(observer.resource.status, { conditions });
  Object.assign(observer.resource.status.atProvider.manifest.status, { conditions });
}
const group = { resource: { status: { conditions, atProvider: { manifest: {
  apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "SecurityGroup",
  metadata: { name: "test-eu-sg", annotations: { "crossplane.io/external-name": "sg-0123456789abcdef0" } },
  spec: { providerConfigRef: { name: "default" }, forProvider: { region: "eu-central-1" } },
  status: { conditions, atProvider: { id: "sg-0123456789abcdef0", region: "eu-central-1" } },
} } } } };
function render(observed: Record<string, any>, composite = xr) {
  const out = execFileSync(binary, [], { input: JSON.stringify({ template: WORKER_LAUNCH_TEMPLATE,
    data: { observed: { composite: { resource: composite }, resources: { "security-group": group, ...observed } } } }), encoding: "utf8" });
  return out.split(/^---$/m).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}
const templateOf = (objects: any[]) => objects.find(r => r.kind === "LaunchTemplate");

test("ownership handoff can preserve bootstrap commands without changing any other worker resource", () => {
  const baseline = manifests();
  const commands = AWS_METADATA_NODE_IP_DISCOVERY_COMMANDS;
  const preserved = manifests("existing", commands);
  const bootstrap = preserved.find(r => r.kind === "K0sWorkerConfigTemplate")!;
  assert.deepEqual(bootstrap.spec.template.spec.preK0sCommands, commands);
  bootstrap.spec.template.spec.preK0sCommands = baseline.find(r => r.kind === "K0sWorkerConfigTemplate")!.spec.template.spec.preK0sCommands;
  assert.deepEqual(preserved, baseline);
});

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
    for (const mismatch of ["binding", "region", "provider-identity", "provider-config"]) {
      const observed = structuredClone({ eip, "data-volume": volume });
      const manifest: any = observed[kind].resource.status.atProvider.manifest;
      if (mismatch === "binding") manifest.metadata.annotations["crossplane.io/external-name"] = "changed";
      if (mismatch === "region") manifest.status.atProvider.region = "us-east-1";
      if (mismatch === "provider-config") manifest.spec.providerConfigRef.name = "different-account";
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
  assert.deepEqual(template.spec.forProvider.networkInterfaces[0].securityGroups, ["sg-0123456789abcdef0"]);
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
  previous.metadata.ownerReferences = [{ controller: true, uid: xr.metadata.uid, name: xr.metadata.name, kind: xr.kind }];
  const recovered = templateOf(render({ "launch-template": { resource: previous } }));
  assert.deepEqual(recovered.spec, previous.spec);
  assert.equal(recovered.metadata.name, previous.metadata.name);
  assert.equal(recovered.metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
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

test("workers without data volumes require the named EIP and security group", () => {
  const diskless = manifests("none").find(r => r.kind === "XAwsWorkerLaunchTemplate")!;
  const result = render({ eip }, diskless);
  assert.equal(result.filter(r => r.kind === "Object").length, 2);
  const script = Buffer.from(templateOf(result)!.spec.forProvider.userData, "base64").toString();
  assert.ok(!script.includes("attach-volume"));
});

const statusOf = (objects: any[]) => objects.find(r => r.kind === xr.kind)!.status;
const observe = (manifest: any) => ({ resource: { status: { conditions, atProvider: { manifest } } } });
function adoptionFixture() {
  const composite = structuredClone(xr);
  composite.spec.handoff = "retain";
  const existing = templateOf(render({ eip, "data-volume": volume }))!;
  existing.metadata = { name: xr.metadata.name, uid: "original-template-uid", annotations: {
    "crossplane.io/external-name": "lt-0123456789abcdef0",
    "argocd.argoproj.io/tracking-id": "original-app:ec2.aws.upbound.io/LaunchTemplate:default/test-node",
    "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
    "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
  } };
  existing.spec.forProvider.userData = Buffer.from("original bootstrap bytes").toString("base64");
  existing.status = { conditions, atProvider: { id: "lt-0123456789abcdef0", name: xr.metadata.name, region: "eu-central-1" } };
  const observations = { eip, "data-volume": volume, "adoption-source": observe(existing) };
  return { composite, existing, observations };
}
function ownedFixture() {
  const fixture = adoptionFixture();
  const first = render(fixture.observations, fixture.composite);
  fixture.composite.status = { handoff: statusOf(first).handoff };
  const owned = templateOf(first)!;
  owned.metadata.uid = fixture.existing.metadata.uid;
  owned.metadata.annotations["crossplane.io/external-name"] = fixture.existing.metadata.annotations["crossplane.io/external-name"];
  owned.metadata.ownerReferences = [{ controller: true, uid: xr.metadata.uid, kind: xr.kind, name: xr.metadata.name }];
  owned.status = fixture.existing.status;
  return { ...fixture, owned, observations: { ...fixture.observations, "adoption-source": observe(owned), "launch-template": { resource: owned } } };
}

test("invalid or stale bindings explicitly prevent auto-ready from accepting observer Ready conditions", () => {
  const invalid = structuredClone(eip);
  invalid.resource.status.atProvider.manifest.status.atProvider.id = "";
  const stale: any = structuredClone(volume);
  stale.resource.status.atProvider.manifest.metadata.generation = 4;
  stale.resource.status.atProvider.manifest.status.conditions = [conditions[0], { type: "Synced", status: "True", observedGeneration: 3 }];
  for (const observed of [{ eip: invalid, "data-volume": volume }, { eip, "data-volume": stale },
    { eip, "data-volume": volume, "security-group": undefined }]) {
    const result = render(observed);
    assert.equal(templateOf(result), undefined);
    assert.equal(statusOf(result).bindingsReady, false);
    for (const object of result.filter(r => r.kind === "Object"))
      assert.equal(object.metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
  }
});

test("retained adoption observes the existing LT and preserves all cloud fields without managing its binding", () => {
  const { composite, existing, observations } = adoptionFixture();
  const result = render(observations, composite);
  const template = templateOf(result)!;
  assert.deepEqual(template.spec.forProvider, existing.spec.forProvider);
  assert.equal(template.metadata.name, existing.metadata.name);
  assert.equal(template.metadata.annotations["crossplane.io/external-name"], undefined);
  assert.equal(template.metadata.annotations["argocd.argoproj.io/tracking-id"], undefined);
  assert.equal(template.metadata.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
  assert.equal(template.spec.deletionPolicy, "Orphan");
  assert.deepEqual(template.spec.managementPolicies, ["Observe", "Update", "LateInitialize"]);
  assert.deepEqual(statusOf(result).handoff, { uid: existing.metadata.uid, externalName: "lt-0123456789abcdef0" });
  assert.equal(statusOf(result).ownershipReady, false);
  const source = result.find(r => r.metadata.annotations?.["gotemplating.fn.crossplane.io/composition-resource-name"] === "adoption-source");
  assert.deepEqual(source.spec.managementPolicies, ["Observe"]);
});

test("retained adoption cannot substitute a missing, rebound, foreign-owned or stale LT", () => {
  for (const failure of ["missing", "binding", "name", "region", "foreign-controller", "stale", "deleted"]) {
    const { composite, existing, observations } = adoptionFixture();
    if (failure === "missing") (observations as any)["adoption-source"] = undefined;
    if (failure === "binding") existing.metadata.annotations["crossplane.io/external-name"] = "lt-aaaaaaaa";
    if (failure === "name") existing.metadata.name = "another-template";
    if (failure === "region") existing.spec.forProvider.region = "us-east-1";
    if (failure === "foreign-controller") existing.metadata.ownerReferences = [{ controller: true, uid: "other", kind: xr.kind, name: xr.metadata.name }];
    if (failure === "stale") existing.status.conditions = [conditions[0], { type: "Synced", status: "False" }];
    if (failure === "deleted") existing.metadata.deletionTimestamp = "2026-10-07T00:00:00Z";
    const result = render(observations, composite);
    assert.equal(templateOf(result), undefined, failure);
    assert.equal(statusOf(result).bindingsReady, false, failure);
  }
});

test("activation requires the same captured UID and external identity under this XR controller", () => {
  for (const failure of ["no-baseline", "wrong-uid", "wrong-external-name", "no-owner", "foreign-owner"]) {
    const { composite, owned, observations } = ownedFixture();
    composite.spec.handoff = "activate";
    if (failure === "no-baseline") delete composite.status;
    if (failure === "wrong-uid") composite.status.handoff.uid = "different-uid";
    if (failure === "wrong-external-name") composite.status.handoff.externalName = "lt-aaaaaaaa";
    if (failure === "no-owner") delete owned.metadata.ownerReferences;
    if (failure === "foreign-owner") owned.metadata.ownerReferences[0].uid = "other-xr";
    const result = render(observations, composite);
    assert.equal(statusOf(result).handoffActive, false, failure);
    const retained = templateOf(result);
    if (retained) {
      assert.equal(retained.spec.deletionPolicy, "Orphan", failure);
      assert.ok(!retained.spec.managementPolicies.includes("Delete"), failure);
    }
  }
});

test("verified activation atomically detaches Argo metadata and restores ordered LT deletion", () => {
  const { composite, observations } = ownedFixture();
  composite.spec.handoff = "activate";
  const result = render(observations, composite);
  const template = templateOf(result)!;
  assert.equal(statusOf(result).handoffActive, true);
  assert.equal(statusOf(result).ownershipReady, true);
  assert.equal(template.spec.deletionPolicy, "Delete");
  assert.deepEqual(template.spec.managementPolicies, ["Observe", "Update", "Delete", "LateInitialize"]);
  for (const key of ["tracking-id", "sync-options", "compare-options", "sync-wave"])
    assert.equal(template.metadata.annotations[`argocd.argoproj.io/${key}`], "");
  assert.equal(template.metadata.annotations["crossplane.io/external-name"], undefined);
  assert.deepEqual(template.spec.forProvider.networkInterfaces[0].securityGroups, ["sg-0123456789abcdef0"]);
  assert.ok(Buffer.from(template.spec.forProvider.userData, "base64").toString().includes("--volume-ids vol-0123456789abcdef0"));
});

test("activation waits for the current LT generation even when the observer still reports an older healthy snapshot", () => {
  const { composite, owned, observations } = ownedFixture();
  composite.spec.handoff = "activate";
  observations["adoption-source"] = structuredClone(observations["adoption-source"]);
  owned.metadata.generation = 2;
  owned.status = { ...owned.status, conditions: [conditions[0], { type: "Synced", status: "True", observedGeneration: 1 }] };
  const pending = render(observations, composite);
  assert.equal(statusOf(pending).bindingsReady, true, "cached source remains healthy");
  assert.equal(statusOf(pending).ownershipReady, true);
  assert.equal(statusOf(pending).launchTemplateReady, false);
  assert.equal(statusOf(pending).handoffActive, false);
  assert.equal(templateOf(pending)!.spec.deletionPolicy, "Orphan");
  assert.equal(templateOf(pending)!.metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
  owned.status.conditions[1].observedGeneration = 2;
  const reconciled = render(observations, composite);
  assert.equal(statusOf(reconciled).launchTemplateReady, true);
  assert.equal(statusOf(reconciled).handoffActive, true);
});

test("observation loss after activation preserves deletion policy and detached tracking without garbage collection", () => {
  const { composite, observations } = ownedFixture();
  composite.spec.handoff = "activate";
  const active = templateOf(render(observations, composite))!;
  active.metadata.ownerReferences = observations["launch-template"].resource.metadata.ownerReferences;
  const result = render({ "launch-template": { resource: active }, "security-group": undefined }, composite);
  const preserved = templateOf(result)!;
  assert.deepEqual(preserved.spec, active.spec);
  assert.equal(preserved.metadata.annotations["argocd.argoproj.io/tracking-id"], "");
  assert.equal(preserved.metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
});

test("node-level observed mode migrates only the selected node and preserves snapshot opt-out", () => {
  const chart = Testing.chart();
  const fleet = new AwsWorkerFleet(chart, "fleet", {
    namePrefix: "test", clusterName: "test", k0sVersion: "v1.36.3+k0s.2", sshPublicKey: "fixture",
    sshSecretName: "test-ssh", dataVgName: "test-vg", tagDomain: "example.test", eipPurpose: "test-worker",
  });
  const region = { geo: "eu", region: "eu-central-1", az: "eu-central-1a", vpcCidr: "10.12.0.0/16", subnetCidr: "10.12.0.0/20" };
  fleet.addNode(region, { name: "selected", ami: "ami-fixture", instanceType: "m6i.xlarge", nodeLabels: {},
    observedIdentity: true, launchTemplateHandoff: "retain", dataVolume: { sizeGi: 100, existing: true, snapshot: false } }, "test-profile");
  fleet.addNode(region, { name: "unchanged", ami: "ami-fixture", instanceType: "m6i.xlarge", nodeLabels: {}, allocationId: "eipalloc-0123456789abcdef0" }, "test-profile");
  const rendered = Testing.synth(chart);
  assert.deepEqual(rendered.filter(r => r.kind === xr.kind).map(r => [r.metadata.name, r.spec.handoff]), [["selected", "retain"]]);
  assert.equal(rendered.find(r => r.kind === xr.kind)!.metadata.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
  assert.deepEqual(rendered.filter(r => r.kind === "LaunchTemplate").map(r => r.metadata.name), ["unchanged"]);
  const disk = rendered.find(r => r.kind === "EBSVolume")!;
  assert.equal(disk.spec.forProvider.tags["example.test/backup"], undefined);
  assert.equal(disk.spec.deletionPolicy, "Orphan");
});
