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
const magic = "example.placeholder/v1\n";

const roles: SealedDiskRole[] = [
  { role: "data", claim: "data", file: "data", sizeBytes: 64 * GiB, sizeLabel: "64Gi", provisioner: "data-disk" },
  { role: "bridge", claim: "bridge", file: "bridge", sizeBytes: GiB, sizeLabel: "1Gi", provisioner: "bridge-disk" },
  { role: "standby", claim: "standby", file: "standby", sizeBytes: 16 * MiB, sizeLabel: "16Mi", provisioner: "standby-disk", placeholder: true },
];
const table = (): DiskTable => ({
  live: { data: { generation: 4, loop: 204 }, bridge: { generation: 2, loop: 206 }, standby: { generation: 2, loop: 207 } },
  retained: [{ role: "data", generation: 3, loop: 203 }],
  retired: [
    { role: "data", generation: 1, loop: 201 },
    { role: "data", generation: 2, loop: 202, declared: true },
    { role: "bridge", generation: 1, loop: 205 },
    { role: "standby", generation: 1, loop: 208, declared: true },
  ],
  reservedLoops: [0, 100, 150],
  protectedLoops: [150],
  firstPinnedLoop: 100,
});
const injector: SealedDisksProps["injector"] = {
  name: "key-injector", image: injectorImage, pluginIndex: "40", runtimeHandler: "kata-qemu-snp", device: { major: 10, minor: 258 },
  bindings: [{ pod: "guest-data", container: "storage" }, { pod: "guest-bridge", container: "storage" }], imagePullSecrets: ["registry-pull"],
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
const live = { data: disk("data", "data", 4, 204, 64 * GiB, "64Gi"), bridge: disk("bridge", "bridge", 2, 206, GiB, "1Gi"),
  standby: disk("standby", "standby", 2, 207, 16 * MiB, "16Mi") };
const retained = [disk("data", "data", 3, 203, 64 * GiB, "64Gi")];
const retiring = [disk("data", "data", 2, 202, 64 * GiB, "64Gi"), disk("standby", "standby", 1, 208, 16 * MiB, "16Mi")];
const raw = (chart: any, objects: object[], prefix: string) => objects.forEach((o, i) => new ApiObject(chart, `${prefix}-${i}`, structuredClone(o) as ApiObjectProps));

test("SealedDisks renders byte-identically to the hand-written provisioners, injector and claims, in that order", () => {
  const expected = synthOf(chart => {
    raw(chart, [provisioner("data-disk", live.data), provisioner("bridge-disk", live.bridge),
      provisioner("standby-disk", live.standby, true)], "provisioner");
    new NriKeyInjector(chart, "injector", { ...injector!, namespace: "guests", nodeName: "guest-host-1" });
    raw(chart, [...[live.data, live.bridge, live.standby, ...retained].flatMap(d => claimPair(d, true)),
      ...retiring.flatMap(d => claimPair(d, false))], "claim");
  });
  const rendered = render(props());
  assert.equal(rendered.yaml, expected.yaml);
  assert.deepEqual(kindsAndNames(rendered.objects), [
    "Deployment/data-disk", "Deployment/bridge-disk", "Deployment/standby-disk", "Deployment/key-injector",
    "PersistentVolume/data-v4", "PersistentVolumeClaim/data-v4", "PersistentVolume/bridge-v2", "PersistentVolumeClaim/bridge-v2",
    "PersistentVolume/standby-v2", "PersistentVolumeClaim/standby-v2",
    "PersistentVolume/data-v3", "PersistentVolumeClaim/data-v3",
    "PersistentVolume/data-v2", "PersistentVolumeClaim/data-v2", "PersistentVolume/standby-v1", "PersistentVolumeClaim/standby-v1",
  ]);
});

test("live and retained claims are pinned against pruning; declared retired ones render once unpinned; others are gone", () => {
  const objects = render(props()).objects;
  const options = (kind: string, name: string) => objects.find(o => o.kind === kind && o.metadata.name === name)?.metadata.annotations["argocd.argoproj.io/sync-options"];
  for (const name of ["data-v4", "bridge-v2", "standby-v2", "data-v3"]) {
    for (const kind of ["PersistentVolume", "PersistentVolumeClaim"]) assert.equal(options(kind, name), "Prune=false,Delete=false", `${kind}/${name}`);
  }
  for (const name of ["data-v2", "standby-v1"]) {
    for (const kind of ["PersistentVolume", "PersistentVolumeClaim"]) assert.equal(options(kind, name), undefined, `${kind}/${name}`);
  }
  const names = objects.map(o => o.metadata.name);
  for (const gone of ["data-v1", "bridge-v1"]) assert.ok(!names.includes(gone), gone);
  // Only live disks are provisioned; the placeholder only on its own disk.
  const scripts = objects.filter(o => o.kind === "Deployment" && o.metadata.name.endsWith("-disk")).map(o => o.spec.template.spec.containers[0].args[0]);
  assert.deepEqual(scripts.map(s => s.includes("printf 'example.placeholder/v1\\n'")), [false, false, true]);
  assert.ok(scripts.every(s => !/loop20[1235]\b/.test(s)));
});

test("the plan names every disk the table declares", () => {
  const plan = sealedDisksPlan(roles, table());
  const tuple = (d: any) => [d.role, d.generation, d.claim, d.file, d.loop, d.device, d.sizeBytes, d.sizeLabel];
  assert.deepEqual(plan.live.map(tuple), [
    ["data", 4, "data-v4", "data-v4.img", 204, "/dev/loop204", 64 * GiB, "64Gi"],
    ["bridge", 2, "bridge-v2", "bridge-v2.img", 206, "/dev/loop206", GiB, "1Gi"],
    ["standby", 2, "standby-v2", "standby-v2.img", 207, "/dev/loop207", 16 * MiB, "16Mi"],
  ]);
  assert.deepEqual(plan.retained.map(tuple), [["data", 3, "data-v3", "data-v3.img", 203, "/dev/loop203", 64 * GiB, "64Gi"]]);
  assert.deepEqual(plan.retiring.map(tuple), [
    ["data", 2, "data-v2", "data-v2.img", 202, "/dev/loop202", 64 * GiB, "64Gi"],
    ["standby", 1, "standby-v1", "standby-v1.img", 208, "/dev/loop208", 16 * MiB, "16Mi"],
  ]);
  let construct!: SealedDisks;
  synthOf(chart => { construct = new SealedDisks(chart, "disks", props()); });
  assert.deepEqual(construct.plan, plan);
});

test("a retained or retired generation keeps the size it was made with", () => {
  // The data role grew from 32Gi to 64Gi: its retained and declared-retired
  // generations keep 32Gi, since a claim with storageClassName "" cannot be
  // resized. A generation without a size of its own takes its role's.
  const resized = (): DiskTable => ({ ...table(),
    retained: [{ role: "data", generation: 3, loop: 203, sizeBytes: 32 * GiB, sizeLabel: "32Gi" }],
    retired: table().retired.map(entry => (entry.role === "data" && entry.generation === 2 ? { ...entry, sizeBytes: 32 * GiB, sizeLabel: "32Gi" } : entry)) });
  const plan = sealedDisksPlan(roles, resized());
  const sizes = (disks: readonly any[]) => disks.map(d => [d.claim, d.sizeBytes, d.sizeLabel]);
  assert.deepEqual(sizes(plan.live), [["data-v4", 64 * GiB, "64Gi"], ["bridge-v2", GiB, "1Gi"], ["standby-v2", 16 * MiB, "16Mi"]]);
  assert.deepEqual(sizes(plan.retained), [["data-v3", 32 * GiB, "32Gi"]]);
  assert.deepEqual(sizes(plan.retiring), [["data-v2", 32 * GiB, "32Gi"], ["standby-v1", 16 * MiB, "16Mi"]]);
  const objects = render(props({ table: resized() })).objects;
  const storage = (kind: string, name: string) => {
    const object = objects.find(o => o.kind === kind && o.metadata.name === name);
    return kind === "PersistentVolume" ? object.spec.capacity.storage : object.spec.resources.requests.storage;
  };
  for (const [name, size] of [["data-v4", "64Gi"], ["data-v3", "32Gi"], ["data-v2", "32Gi"], ["standby-v1", "16Mi"]]) {
    for (const kind of ["PersistentVolume", "PersistentVolumeClaim"]) assert.equal(storage(kind, name), size, `${kind}/${name}`);
  }
  assert.throws(() => sealedDisksPlan(roles, { ...resized(), retained: [{ role: "data", generation: 3, loop: 203, sizeBytes: 32 * GiB } as any] }), /sizeLabel/);
});

test("a role without a provisioner renders its claims only, and the injector is optional", () => {
  const noStandby = roles.map(r => r.role === "standby" ? { ...r, provisioner: undefined } : r);
  const objects = render(props({ roles: noStandby, injector: undefined })).objects;
  assert.deepEqual(kindsAndNames(objects).slice(0, 4), ["Deployment/data-disk", "Deployment/bridge-disk",
    "PersistentVolume/data-v4", "PersistentVolumeClaim/data-v4"]);
  assert.ok(kindsAndNames(objects).includes("PersistentVolume/standby-v2"));
  // Without a placeholder provisioner no magic is needed.
  assert.doesNotThrow(() => render(props({ roles: noStandby, placeholderMagic: undefined })));
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
    ["table invalid", p => { p.table.live.data.loop = 203; }, /allocated twice/],
    ["role without a layout", { roles: roles.slice(0, 2) }, /standby/],
    ["layout without a live disk", p => { delete p.table.live.standby; }, /standby/],
    ["role twice", { roles: [...roles, roles[0]] }, /role/],
    ["claim prefix shared", { roles: roles.map(r => r.role === "standby" ? { ...r, claim: "data" } : r) }, /claim/],
    ["file prefix shared", { roles: roles.map(r => r.role === "standby" ? { ...r, file: "data" } : r) }, /file/],
    ["provisioner name twice", { roles: roles.map(r => r.role === "standby" ? { ...r, provisioner: "data-disk" } : r) }, /provisioner/],
    ["provisioner named like the injector", { roles: roles.map(r => r.role === "standby" ? { ...r, provisioner: "key-injector" } : r) }, /key-injector/],
    ["placeholder without magic", { placeholderMagic: undefined }, /placeholderMagic/],
    ["size label", { roles: roles.map(r => r.role === "data" ? { ...r, sizeLabel: "32Gi" } : r) }, /sizeLabel/],
    ["claim prefix", { roles: roles.map(r => r.role === "data" ? { ...r, claim: "Node" } : r) }, /claim/],
    ["tagged image", { image: "registry.example.com/guests/storage:1" }, /digestImage/],
    ["state dir", { stateDir: "/var/lib/guests/" }, /stateDir/],
    ["namespace", { namespace: "" }, /namespace/],
    ["data", { nodeName: "Guest Host" }, /nodeName/],
    ["sync wave", { syncWave: Number.NaN }, /syncWave/],
    ["misspelt role field", { roles: roles.map(r => r.role === "standby" ? { ...r, provisioner: undefined, provisoner: "standby-disk" } as any : r) }, /unknown field provisoner/],
    ["misspelt prop", p => { p.injectr = p.injector; delete p.injector; }, /unknown field injectr/],
    ["injector namespace", p => { p.injector = { ...p.injector, namespace: "elsewhere" }; }, /namespace/],
    ["placeholder flag", { roles: roles.map(r => r.role === "standby" ? { ...r, placeholder: "yes" } as any : r) }, /placeholder/],
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
