import { Construct } from "constructs";
import { KubeDeployment, KubePersistentVolume, KubePersistentVolumeClaim, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { validateDiskTable, type DiskEntry, type DiskTable } from "./disk-table";
import { NriKeyInjector, type NriKeyInjectorProps } from "./key-injector";
import { provisionScript, validSize, type ProvisionTemplate } from "./provision";
import {
  KEEP_ANNOTATION, dnsLabel, dnsSubdomain, fail, hostPath, image, isPlainObject, knownFields, labels, pullSecrets, waveAnnotation,
} from "./validate";

/** How one role's disks are named and sized; generation g of the role renders as `<claim>-v<g>` backed by `<file>-v<g>.img`. */
export interface SealedDiskRole {
  /** Role name, as keyed in the table's `live`. */
  readonly role: string;
  /** PersistentVolume and PersistentVolumeClaim name prefix. */
  readonly claim: string;
  /** Backing file name prefix inside the state directory. */
  readonly file: string;
  /** Size in bytes: a positive multiple of 512. */
  readonly sizeBytes: number;
  /** The same size as a Kubernetes quantity (plain bytes or a binary suffix). */
  readonly sizeLabel: string;
  /** Deployment that provisions the live generation. Omit to render the role's claims without a provisioner. */
  readonly provisioner?: string;
  /** The live disk is a stage placeholder: see {@link SealedDisksProps.placeholderMagic}. */
  readonly placeholder?: boolean;
  /** Provisioner Pod labels and selector. Default `{ app: "<namespace>-<provisioner>" }`. */
  readonly podLabels?: Readonly<Record<string, string>>;
}

/** One disk of the plan. */
export interface SealedDisk {
  readonly role: string;
  readonly generation: number;
  /** PersistentVolume and PersistentVolumeClaim name. */
  readonly claim: string;
  /** Backing file name inside the state directory. */
  readonly file: string;
  readonly loop: number;
  /** `/dev/loop<loop>`, the PersistentVolume's local path. */
  readonly device: string;
  readonly sizeBytes: number;
  readonly sizeLabel: string;
}

/** The disks a table declares, each in emission order. */
export interface SealedDisksPlan {
  /** Live generations, in role order. */
  readonly live: readonly SealedDisk[];
  /** Retained generations, in table order. */
  readonly retained: readonly SealedDisk[];
  /** Retired generations still declared (rendered once more without prune protection), in table order. */
  readonly retiring: readonly SealedDisk[];
}

export interface SealedDisksProps {
  readonly namespace: string;
  /** The host the disks, provisioners and claims are bound to (also its `kubernetes.io/hostname`). */
  readonly nodeName: string;
  /** Digest-pinned provisioner image: a shell with flock, fallocate, losetup, stat, mknod and sha256sum. */
  readonly image: string;
  /** Host directory of the backing files, mounted into every provisioner at the same path. */
  readonly stateDir: string;
  /** Every role of the table, in emission order. */
  readonly roles: readonly SealedDiskRole[];
  readonly table: DiskTable;
  /**
   * First-sector magic of a stage placeholder disk; required when a role
   * with `placeholder` has a provisioner. The guest's storage layer must
   * accept the same magic.
   */
  readonly placeholderMagic?: string;
  /** Provisioning script template. Default: the module's (see provisionScript). */
  readonly template?: ProvisionTemplate;
  readonly imagePullSecrets?: readonly string[];
  /**
   * The key injector for the guests of these disks, rendered between the
   * provisioners and the claims, in this namespace on this node.
   */
  readonly injector?: Omit<NriKeyInjectorProps, "namespace" | "nodeName">;
  /** Argo CD sync wave of every object (and the injector's default). Default -1. */
  readonly syncWave?: number;
}

const WHERE = "SealedDisks";
const ROLE_FIELDS = ["role", "claim", "file", "sizeBytes", "sizeLabel", "provisioner", "placeholder", "podLabels"];
const PROPS_FIELDS = [
  "namespace", "nodeName", "image", "stateDir", "roles", "table", "placeholderMagic", "template", "imagePullSecrets", "injector", "syncWave",
];

function validRoles(roles: unknown, where: string): SealedDiskRole[] {
  if (!Array.isArray(roles) || roles.length === 0) fail(where, `roles must list every role of the table`);
  const seen = { role: new Set<string>(), claim: new Set<string>(), file: new Set<string>() };
  return roles.map((layout: SealedDiskRole) => {
    knownFields(where, "a role", layout, ROLE_FIELDS);
    for (const field of ["role", "claim", "file"] as const) {
      const value = layout[field];
      if (field === "file") {
        if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value)) fail(where, `invalid file prefix ${JSON.stringify(value)}`);
      } else {
        dnsLabel(where, `${field} of role ${JSON.stringify(layout.role)}`, value);
      }
      if (seen[field].has(value)) fail(where, `two roles share the ${field} ${JSON.stringify(value)}`);
      seen[field].add(value);
    }
    validSize(layout.sizeBytes, layout.sizeLabel, `${where}: role ${JSON.stringify(layout.role)}`);
    if (layout.placeholder !== undefined && typeof layout.placeholder !== "boolean") {
      fail(where, `placeholder of role ${JSON.stringify(layout.role)} must be a boolean`);
    }
    return layout;
  });
}

const diskOf = (layout: SealedDiskRole, role: string, { generation, loop }: DiskEntry): SealedDisk => ({
  role, generation, claim: `${layout.claim}-v${generation}`, file: `${layout.file}-v${generation}.img`, loop, device: `/dev/loop${loop}`,
  sizeBytes: layout.sizeBytes, sizeLabel: layout.sizeLabel,
});

/**
 * Validate the table against the role layouts and name every disk it
 * declares. Each role of the table needs exactly one layout.
 */
export function sealedDisksPlan(roles: readonly SealedDiskRole[], table: DiskTable): SealedDisksPlan {
  const layouts = validRoles(roles, "sealedDisksPlan");
  const byRole = new Map(layouts.map(layout => [layout.role, layout]));
  if (isPlainObject(table) && isPlainObject(table.live)) {
    for (const role of Object.keys(table.live)) {
      if (!byRole.has(role)) fail("sealedDisksPlan", `live role ${JSON.stringify(role)} has no layout in roles`);
    }
    for (const layout of layouts) {
      if (!Object.hasOwn(table.live, layout.role)) fail("sealedDisksPlan", `role ${JSON.stringify(layout.role)} has no live disk in the table`);
    }
  }
  validateDiskTable(table);
  const disk = (role: string, entry: DiskEntry) => diskOf(byRole.get(role)!, role, entry);
  return {
    live: layouts.map(layout => disk(layout.role, table.live[layout.role])),
    retained: table.retained.map(({ role, generation, loop }) => disk(role, { generation, loop })),
    retiring: table.retired.filter(entry => entry.declared).map(({ role, generation, loop }) => disk(role, { generation, loop })),
  };
}

/**
 * Loop-file block disks for confidential guests on one host, from a disk
 * table: a privileged provisioner per live disk that creates (once), checks
 * and attaches its backing file (see provisionScript); optionally the key
 * injector; then a local block PersistentVolume and its claim per declared
 * disk. Live and retained claims are protected from pruning and deletion;
 * retiring ones render once more without that protection.
 *
 * Emission order: provisioners (role order), injector, live claims (role
 * order), retained claims, retiring claims (table order); each claim as its
 * PersistentVolume then its PersistentVolumeClaim.
 */
export class SealedDisks extends Construct {
  public readonly plan: SealedDisksPlan;

  constructor(scope: Construct, id: string, props: SealedDisksProps) {
    super(scope, id);
    knownFields(WHERE, "props", props, PROPS_FIELDS);
    const namespace = dnsLabel(WHERE, "namespace", props.namespace);
    const nodeName = dnsSubdomain(WHERE, "nodeName", props.nodeName);
    const pinned = image(WHERE, "image", props.image);
    const stateDir = hostPath(WHERE, "stateDir", props.stateDir);
    const imagePullSecrets = pullSecrets(WHERE, props.imagePullSecrets);
    const wave = waveAnnotation(WHERE, "syncWave", props.syncWave ?? -1);
    const roles = validRoles(props.roles, WHERE);
    try {
      this.plan = sealedDisksPlan(roles, props.table);
    } catch (e) {
      fail(WHERE, (e as Error).message);
    }
    const provisioned = roles.filter(layout => layout.provisioner !== undefined);
    const names = provisioned.map(layout => dnsLabel(WHERE, `provisioner of role ${JSON.stringify(layout.role)}`, layout.provisioner));
    if (new Set(names).size !== names.length) fail(WHERE, `two roles share a provisioner name`);
    if (props.injector && ("namespace" in props.injector || "nodeName" in props.injector)) {
      fail(WHERE, `the injector takes the disks' namespace and nodeName; do not set them on injector`);
    }
    if (props.injector && names.includes(props.injector.name)) {
      fail(WHERE, `provisioner name ${JSON.stringify(props.injector.name)} is the injector's`);
    }
    if (provisioned.some(layout => layout.placeholder) && props.placeholderMagic === undefined) {
      fail(WHERE, `placeholderMagic is required for a placeholder role with a provisioner`);
    }
    // Validates every role's size, including roles without a provisioner.
    const scripts = new Map(this.plan.live.map(disk => {
      const layout = roles.find(value => value.role === disk.role)!;
      const script = provisionScript({
        stateDir, file: disk.file, loop: disk.loop, sizeBytes: disk.sizeBytes, sizeLabel: disk.sizeLabel, template: props.template,
        ...(layout.placeholder ? { placeholderMagic: props.placeholderMagic } : {}),
      });
      return [disk.role, script] as const;
    }));

    for (const layout of provisioned) {
      const name = layout.provisioner!;
      const disk = this.plan.live.find(value => value.role === layout.role)!;
      const podLabels = labels(WHERE, `podLabels of role ${JSON.stringify(layout.role)}`, layout.podLabels ?? { app: `${namespace}-${name}` });
      new KubeDeployment(this, `provisioner-${name}`, {
        metadata: { name, namespace, annotations: { ...wave } },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          selector: { matchLabels: { ...podLabels } },
          template: {
            metadata: { labels: { ...podLabels } },
            spec: {
              nodeName,
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              ...(imagePullSecrets ? { imagePullSecrets } : {}),
              containers: [{
                name: "provisioner",
                image: pinned,
                command: ["/bin/sh", "-ec"],
                args: [scripts.get(layout.role)!],
                securityContext: { privileged: true, readOnlyRootFilesystem: true },
                volumeMounts: [{ name: "dev", mountPath: "/dev" }, { name: "backing", mountPath: stateDir }],
                resources: {
                  requests: { cpu: Quantity.fromString("10m"), memory: Quantity.fromString("32Mi") },
                  limits: { memory: Quantity.fromString("128Mi") },
                },
                readinessProbe: {
                  exec: { command: ["/bin/sh", "-ec", `test "$(losetup -j ${stateDir}/${disk.file} -n -O NAME)" = ${disk.device}`] },
                  periodSeconds: 5,
                },
              }],
              volumes: [
                { name: "dev", hostPath: { path: "/dev", type: "Directory" } },
                { name: "backing", hostPath: { path: stateDir, type: "DirectoryOrCreate" } },
              ],
            },
          },
        },
      });
    }

    if (props.injector) {
      new NriKeyInjector(this, "injector", { ...props.injector, syncWave: props.injector.syncWave ?? props.syncWave ?? -1, namespace, nodeName });
    }

    const claims = [
      ...[...this.plan.live, ...this.plan.retained].map(disk => [disk, true] as const),
      ...this.plan.retiring.map(disk => [disk, false] as const),
    ];
    for (const [disk, pinnedClaim] of claims) {
      const annotations = () => ({ ...wave, ...(pinnedClaim ? KEEP_ANNOTATION : {}) });
      new KubePersistentVolume(this, `volume-${disk.claim}`, {
        metadata: { name: disk.claim, annotations: annotations() },
        spec: {
          capacity: { storage: Quantity.fromString(disk.sizeLabel) },
          volumeMode: "Block",
          accessModes: ["ReadWriteOnce"],
          persistentVolumeReclaimPolicy: "Retain",
          storageClassName: "",
          local: { path: disk.device },
          claimRef: { name: disk.claim, namespace },
          nodeAffinity: {
            required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [nodeName] }] }] },
          },
        },
      });
      new KubePersistentVolumeClaim(this, `claim-${disk.claim}`, {
        metadata: { name: disk.claim, namespace, annotations: annotations() },
        spec: {
          volumeMode: "Block",
          accessModes: ["ReadWriteOnce"],
          storageClassName: "",
          volumeName: disk.claim,
          resources: { requests: { storage: Quantity.fromString(disk.sizeLabel) } },
        },
      });
    }
  }
}
