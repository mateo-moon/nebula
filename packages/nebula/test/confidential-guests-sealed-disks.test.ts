import assert from "node:assert/strict";
import test from "node:test";
import { ApiObject, type ApiObjectProps } from "cdk8s";
import {
  NriKeyInjector, SealedDisks, provisionScript, sealedDisksPlan, type DiskTable, type SealedDiskRole, type SealedDisksProps,
} from "../src/modules/k8s/confidential-guests";
import { kindsAndNames, synthOf } from "./support/cdk8s-render";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const image = `registry.example.com/guests/storage@sha256:${"5".repeat(64)}`;
const injectorImage = `registry.example.com/guests/key-injector@sha256:${"1".repeat(64)}`;
const stateDir = "/var/lib/guests";
const magic = "EXAMPLE-STAGE-PLACEHOLDER-V1\n";

const roles: SealedDiskRole[] = [
  { role: "node", claim: "node-data", file: "data", sizeBytes: 64 * GiB, sizeLabel: "64Gi", provisioner: "volume-provisioner" },
  { role: "maintenance", claim: "workspace", file: "workspace", sizeBytes: GiB, sizeLabel: "1Gi", provisioner: "workspace-provisioner" },
  { role: "stage", claim: "node-stage", file: "stage", sizeBytes: 16 * MiB, sizeLabel: "16Mi", provisioner: "stage-provisioner", placeholder: true },
];
const table = (): DiskTable => ({
  live: { node: { generation: 4, loop: 204 }, maintenance: { generation: 2, loop: 206 }, stage: { generation: 2, loop: 207 } },
  retained: [{ role: "node", generation: 3, loop: 203 }],
  retired: [
    { role: "node", generation: 1, loop: 201 },
    { role: "node", generation: 2, loop: 202, declared: true },
    { role: "maintenance", generation: 1, loop: 205 },
    { role: "stage", generation: 1, loop: 208, declared: true },
  ],
  reservedLoops: [0, 100, 150],
  protectedLoops: [150],
  firstPinnedLoop: 100,
});
const injector: SealedDisksProps["injector"] = {
  name: "key-injector", image: injectorImage, pluginIndex: "90", runtimeHandler: "kata-qemu-snp", device: { major: 10, minor: 258 },
  bindings: [{ pod: "node", container: "storage" }, { pod: "maintenance", container: "storage" }], imagePullSecrets: ["registry-pull"],
};
const props = (change: Partial<SealedDisksProps> = {}): SealedDisksProps => ({
  namespace: "guests", nodeName: "guest-host-1", image, stateDir, roles, table: table(), placeholderMagic: magic,
  imagePullSecrets: ["registry-pull"], injector, ...change,
});
const render = (value: SealedDisksProps) => synthOf(chart => new SealedDisks(chart, "disks", value));

// The disks as plain manifests, in the shape the host helpers and claims were
// first written by hand.
interface Disk { claim: string; file: string; loop: number; device: string; sizeBytes: number; sizeLabel: string }
const disk = (claim: string, file: string, generation: number, loop: number, sizeBytes: number, sizeLabel: string): Disk =>
  ({ claim: `${claim}-v${generation}`, file: `${file}-v${generation}.img`, loop, device: `/dev/loop${loop}`, sizeBytes, sizeLabel });
const meta = (name: string) => ({ name, namespace: "guests", annotations: { "argocd.argoproj.io/sync-wave": "-1" } });
const provisioner = (name: string, d: Disk, placeholder = false) => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: meta(name), spec: {
  replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: `guests-${name}` } }, template: {
    metadata: { labels: { app: `guests-${name}` } }, spec: { nodeName: "guest-host-1", automountServiceAccountToken: false, enableServiceLinks: false,
      imagePullSecrets: [{ name: "registry-pull" }], containers: [{
        name: "provisioner", image, command: ["/bin/sh", "-ec"],
        args: [provisionScript({ stateDir, file: d.file, loop: d.loop, sizeBytes: d.sizeBytes, sizeLabel: d.sizeLabel, ...(placeholder ? { placeholderMagic: magic } : {}) })],
        securityContext: { privileged: true, readOnlyRootFilesystem: true },
        volumeMounts: [{ name: "dev", mountPath: "/dev" }, { name: "backing", mountPath: stateDir }],
        resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
        readinessProbe: { exec: { command: ["/bin/sh", "-ec", `test "$(losetup -j ${stateDir}/${d.file} -n -O NAME)" = ${d.device}`] }, periodSeconds: 5 },
      }], volumes: [{ name: "dev", hostPath: { path: "/dev", type: "Directory" } }, { name: "backing", hostPath: { path: stateDir, type: "DirectoryOrCreate" } }] },
  },
} });
const claimPair = (d: Disk, pinned: boolean) => {
  const annotations = () => ({ "argocd.argoproj.io/sync-wave": "-1", ...(pinned ? { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } : {}) });
  return [
    { apiVersion: "v1", kind: "PersistentVolume", metadata: { name: d.claim, annotations: annotations() }, spec: {
      capacity: { storage: d.sizeLabel }, volumeMode: "Block", accessModes: ["ReadWriteOnce"], persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "", local: { path: d.device }, claimRef: { name: d.claim, namespace: "guests" },
      nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["guest-host-1"] }] }] } },
    } },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: d.claim, namespace: "guests", annotations: annotations() }, spec: {
      volumeMode: "Block", accessModes: ["ReadWriteOnce"], storageClassName: "", volumeName: d.claim, resources: { requests: { storage: d.sizeLabel } },
    } }];
};
const live = { node: disk("node-data", "data", 4, 204, 64 * GiB, "64Gi"), maintenance: disk("workspace", "workspace", 2, 206, GiB, "1Gi"),
  stage: disk("node-stage", "stage", 2, 207, 16 * MiB, "16Mi") };
const retained = [disk("node-data", "data", 3, 203, 64 * GiB, "64Gi")];
const retiring = [disk("node-data", "data", 2, 202, 64 * GiB, "64Gi"), disk("node-stage", "stage", 1, 208, 16 * MiB, "16Mi")];
const raw = (chart: any, objects: object[], prefix: string) => objects.forEach((o, i) => new ApiObject(chart, `${prefix}-${i}`, structuredClone(o) as ApiObjectProps));

test("SealedDisks renders byte-identically to the hand-written provisioners, injector and claims, in that order", () => {
  const expected = synthOf(chart => {
    raw(chart, [provisioner("volume-provisioner", live.node), provisioner("workspace-provisioner", live.maintenance),
      provisioner("stage-provisioner", live.stage, true)], "provisioner");
    new NriKeyInjector(chart, "injector", { ...injector!, namespace: "guests", nodeName: "guest-host-1" });
    raw(chart, [...[live.node, live.maintenance, live.stage, ...retained].flatMap(d => claimPair(d, true)),
      ...retiring.flatMap(d => claimPair(d, false))], "claim");
  });
  const rendered = render(props());
  assert.equal(rendered.yaml, expected.yaml);
  assert.deepEqual(kindsAndNames(rendered.objects), [
    "Deployment/volume-provisioner", "Deployment/workspace-provisioner", "Deployment/stage-provisioner", "Deployment/key-injector",
    "PersistentVolume/node-data-v4", "PersistentVolumeClaim/node-data-v4", "PersistentVolume/workspace-v2", "PersistentVolumeClaim/workspace-v2",
    "PersistentVolume/node-stage-v2", "PersistentVolumeClaim/node-stage-v2",
    "PersistentVolume/node-data-v3", "PersistentVolumeClaim/node-data-v3",
    "PersistentVolume/node-data-v2", "PersistentVolumeClaim/node-data-v2", "PersistentVolume/node-stage-v1", "PersistentVolumeClaim/node-stage-v1",
  ]);
});

test("live and retained claims are pinned against pruning; declared retired ones render once unpinned; others are gone", () => {
  const objects = render(props()).objects;
  const options = (kind: string, name: string) => objects.find(o => o.kind === kind && o.metadata.name === name)?.metadata.annotations["argocd.argoproj.io/sync-options"];
  for (const name of ["node-data-v4", "workspace-v2", "node-stage-v2", "node-data-v3"]) {
    for (const kind of ["PersistentVolume", "PersistentVolumeClaim"]) assert.equal(options(kind, name), "Prune=false,Delete=false", `${kind}/${name}`);
  }
  for (const name of ["node-data-v2", "node-stage-v1"]) {
    for (const kind of ["PersistentVolume", "PersistentVolumeClaim"]) assert.equal(options(kind, name), undefined, `${kind}/${name}`);
  }
  const names = objects.map(o => o.metadata.name);
  for (const gone of ["node-data-v1", "workspace-v1"]) assert.ok(!names.includes(gone), gone);
  // Only live disks are provisioned; the placeholder only on its own disk.
  const scripts = objects.filter(o => o.kind === "Deployment" && o.metadata.name.endsWith("-provisioner")).map(o => o.spec.template.spec.containers[0].args[0]);
  assert.deepEqual(scripts.map(s => s.includes("printf 'EXAMPLE-STAGE-PLACEHOLDER-V1\\n'")), [false, false, true]);
  assert.ok(scripts.every(s => !/loop20[1235]\b/.test(s)));
});

test("the plan names every disk the table declares", () => {
  const plan = sealedDisksPlan(roles, table());
  const tuple = (d: any) => [d.role, d.generation, d.claim, d.file, d.loop, d.device, d.sizeBytes, d.sizeLabel];
  assert.deepEqual(plan.live.map(tuple), [
    ["node", 4, "node-data-v4", "data-v4.img", 204, "/dev/loop204", 64 * GiB, "64Gi"],
    ["maintenance", 2, "workspace-v2", "workspace-v2.img", 206, "/dev/loop206", GiB, "1Gi"],
    ["stage", 2, "node-stage-v2", "stage-v2.img", 207, "/dev/loop207", 16 * MiB, "16Mi"],
  ]);
  assert.deepEqual(plan.retained.map(tuple), [["node", 3, "node-data-v3", "data-v3.img", 203, "/dev/loop203", 64 * GiB, "64Gi"]]);
  assert.deepEqual(plan.retiring.map(tuple), [
    ["node", 2, "node-data-v2", "data-v2.img", 202, "/dev/loop202", 64 * GiB, "64Gi"],
    ["stage", 1, "node-stage-v1", "stage-v1.img", 208, "/dev/loop208", 16 * MiB, "16Mi"],
  ]);
  let construct!: SealedDisks;
  synthOf(chart => { construct = new SealedDisks(chart, "disks", props()); });
  assert.deepEqual(construct.plan, plan);
});

test("a role without a provisioner renders its claims only, and the injector is optional", () => {
  const noStage = roles.map(r => r.role === "stage" ? { ...r, provisioner: undefined } : r);
  const objects = render(props({ roles: noStage, injector: undefined })).objects;
  assert.deepEqual(kindsAndNames(objects).slice(0, 4), ["Deployment/volume-provisioner", "Deployment/workspace-provisioner",
    "PersistentVolume/node-data-v4", "PersistentVolumeClaim/node-data-v4"]);
  assert.ok(kindsAndNames(objects).includes("PersistentVolume/node-stage-v2"));
  // Without a placeholder provisioner no magic is needed.
  assert.doesNotThrow(() => render(props({ roles: noStage, placeholderMagic: undefined })));
});

test("the injector runs in the disks' namespace on their node", () => {
  const [, , , deployment] = render(props()).objects;
  assert.equal(deployment.metadata.namespace, "guests");
  assert.equal(deployment.spec.template.spec.nodeName, "guest-host-1");
  assert.throws(() => render(props({ injector: { ...injector!, targetNamespace: "elsewhere" } })), /targetNamespace/);
});

test("required props and invariants are enforced", () => {
  const refusals: [string, Partial<SealedDisksProps> | ((p: any) => void), RegExp][] = [
    ["protectedLoops missing", p => { delete p.table.protectedLoops; }, /protectedLoops/],
    ["firstPinnedLoop missing", p => { delete p.table.firstPinnedLoop; }, /firstPinnedLoop/],
    ["table invalid", p => { p.table.live.node.loop = 203; }, /allocated twice/],
    ["role without a layout", { roles: roles.slice(0, 2) }, /stage/],
    ["layout without a live disk", p => { delete p.table.live.stage; }, /stage/],
    ["role twice", { roles: [...roles, roles[0]] }, /role/],
    ["claim prefix shared", { roles: roles.map(r => r.role === "stage" ? { ...r, claim: "node-data" } : r) }, /claim/],
    ["file prefix shared", { roles: roles.map(r => r.role === "stage" ? { ...r, file: "data" } : r) }, /file/],
    ["provisioner name twice", { roles: roles.map(r => r.role === "stage" ? { ...r, provisioner: "volume-provisioner" } : r) }, /provisioner/],
    ["provisioner named like the injector", { roles: roles.map(r => r.role === "stage" ? { ...r, provisioner: "key-injector" } : r) }, /key-injector/],
    ["placeholder without magic", { placeholderMagic: undefined }, /placeholderMagic/],
    ["size label", { roles: roles.map(r => r.role === "node" ? { ...r, sizeLabel: "32Gi" } : r) }, /sizeLabel/],
    ["claim prefix", { roles: roles.map(r => r.role === "node" ? { ...r, claim: "Node" } : r) }, /claim/],
    ["tagged image", { image: "registry.example.com/guests/storage:1" }, /digestImage/],
    ["state dir", { stateDir: "/var/lib/guests/" }, /stateDir/],
    ["namespace", { namespace: "" }, /namespace/],
    ["node", { nodeName: "Guest Host" }, /nodeName/],
    ["sync wave", { syncWave: Number.NaN }, /syncWave/],
    ["misspelt role field", { roles: roles.map(r => r.role === "stage" ? { ...r, provisioner: undefined, provisoner: "stage-provisioner" } as any : r) }, /unknown field provisoner/],
    ["misspelt prop", p => { p.injectr = p.injector; delete p.injector; }, /unknown field injectr/],
    ["injector namespace", p => { p.injector = { ...p.injector, namespace: "elsewhere" }; }, /namespace/],
    ["placeholder flag", { roles: roles.map(r => r.role === "stage" ? { ...r, placeholder: "yes" } as any : r) }, /placeholder/],
  ];
  for (const [label, change, error] of refusals) {
    const value: any = props();
    if (typeof change === "function") change(value); else Object.assign(value, change);
    assert.throws(() => render(value), error, label);
  }
});

test("a custom provisioning template and sync wave are honoured", () => {
  const template = { reference: { stateDir: "/srv/ref", file: "ref-v1.img", loop: 250, sizeBytes: 16 * MiB, sizeLabel: "16Mi" },
    script: provisionScript({ stateDir: "/srv/ref", file: "ref-v1.img", loop: 250, sizeBytes: 16 * MiB, sizeLabel: "16Mi" }) + "# custom\n" };
  const objects = render(props({ template, syncWave: -7 })).objects;
  const script: string = objects[0].spec.template.spec.containers[0].args[0];
  assert.ok(script.endsWith("# custom\n") && script.includes("device=/dev/loop204\n"));
  assert.ok(objects.every(o => o.metadata.annotations["argocd.argoproj.io/sync-wave"] === "-7"));
});
