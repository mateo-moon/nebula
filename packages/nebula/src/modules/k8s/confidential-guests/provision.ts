import { createHash } from "node:crypto";
import { readConfidentialGuestAsset } from "./assets";
import { boundedInteger, hostPath } from "./validate";

/** The disk a provisioning template was written for, as literal values in its text. */
export interface ProvisionReference {
  readonly stateDir: string;
  readonly file: string;
  readonly loop: number;
  readonly sizeBytes: number;
  readonly sizeLabel: string;
}

/**
 * A provisioning script written, and runnable, for one reference disk. It is
 * retargeted to another disk by replacing the reference values: the state
 * directory, the backing file, `/dev/loop<minor>`, `b 7 <minor>`,
 * `'7:<minor in hex>'`, the size in bytes and the size label. Each must occur
 * in the script, and none may contain another.
 */
export interface ProvisionTemplate {
  readonly script: string;
  readonly reference: ProvisionReference;
}

export interface ProvisionScriptProps {
  /** Host directory holding the backing files (and the provisioning lock). */
  readonly stateDir: string;
  /** Backing file name inside stateDir. */
  readonly file: string;
  /** Loop minor the file is attached to. */
  readonly loop: number;
  /** Backing file size: a positive multiple of 512. */
  readonly sizeBytes: number;
  /** The same size as a Kubernetes quantity: plain bytes or a binary suffix (Ki..Ei). */
  readonly sizeLabel: string;
  /**
   * Makes the disk a stage placeholder: a new file starts with this magic
   * (then zeros) instead of zeros, and a file whose first sector differs is
   * refused. Printable ASCII without `'`, `%`, `\`, spaces or shell
   * metacharacters, optionally ending in one line feed, at most 512 bytes.
   */
  readonly placeholderMagic?: string;
  /** Defaults to {@link defaultProvisionTemplate}. */
  readonly template?: ProvisionTemplate;
}

// The reference disk of assets/provision.sh.
const DEFAULT_REFERENCE: ProvisionReference = Object.freeze({
  stateDir: "/var/lib/sealed-disks", file: "data-v1.img", loop: 123, sizeBytes: 1073741824, sizeLabel: "1Gi",
});

/** The shipped provisioning script and its reference disk (read from the module's assets when called). */
export function defaultProvisionTemplate(): ProvisionTemplate {
  return { script: readConfidentialGuestAsset("provision.sh"), reference: DEFAULT_REFERENCE };
}

const WHERE = "provisionScript";
const FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SIZE_LABEL = /^([1-9][0-9]*)(Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const UNITS: Record<string, bigint> = { Ki: 1n << 10n, Mi: 1n << 20n, Gi: 1n << 30n, Ti: 1n << 40n, Pi: 1n << 50n, Ei: 1n << 60n };
const MAGIC = /^[A-Za-z0-9._:=+/-]+\n?$/;
// The anchors a placeholder rewrites: file creation, and the end of the
// backing-file check after which the first-sector check goes.
const CREATED = '(set -C; : > "$file")';
const UNCHANGED = "  echo 'refusing changed backing file'; exit 1;\n}\n";

function validDisk(props: ProvisionReference, where: string): ProvisionReference {
  hostPath(props.stateDir, where, "stateDir");
  if (typeof props.file !== "string" || !FILE.test(props.file)) {
    throw new TypeError(`${where}: file must be a file name of [A-Za-z0-9._-] not starting with '.', got ${JSON.stringify(props.file)}`);
  }
  boundedInteger(props.loop, 0, 1 << 20, where, "loop");
  validSize(props.sizeBytes, props.sizeLabel, where);
  return props;
}

/** A disk size in bytes (a positive multiple of 512) and the same size as a quantity (plain bytes or a binary suffix). */
export function validSize(sizeBytes: unknown, sizeLabel: unknown, where: string): void {
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0 || (sizeBytes as number) % 512 !== 0) {
    throw new TypeError(`${where}: sizeBytes must be a positive multiple of 512, got ${String(sizeBytes)}`);
  }
  const label = typeof sizeLabel === "string" ? SIZE_LABEL.exec(sizeLabel) : null;
  if (!label || BigInt(label[1]) * (label[2] ? UNITS[label[2]] : 1n) !== BigInt(sizeBytes as number)) {
    throw new TypeError(`${where}: sizeLabel must state sizeBytes (${String(sizeBytes)}) in bytes or with a binary suffix, got ${JSON.stringify(sizeLabel)}`);
  }
}

const tokens = (disk: ProvisionReference): string[] => [
  disk.stateDir, disk.file, `/dev/loop${disk.loop}`, `b 7 ${disk.loop}`, `'7:${disk.loop.toString(16)}'`, String(disk.sizeBytes), disk.sizeLabel,
];

function placeholderSector(magic: unknown): { printf: string; sha256: string } {
  if (typeof magic !== "string" || !MAGIC.test(magic) || Buffer.byteLength(magic, "ascii") > 512) {
    throw new TypeError(`${WHERE}: placeholder magic must be at most 512 bytes of [A-Za-z0-9._:=+/-], optionally ending in one line feed`);
  }
  const sector = Buffer.alloc(512);
  sector.write(magic, "ascii");
  return { printf: magic.replace(/\n$/, "\\n"), sha256: createHash("sha256").update(sector).digest("hex") };
}

/**
 * The script a privileged provisioner runs to create (once), check and attach
 * a loop-backed disk: it refuses a symlinked, resized or hard-linked backing
 * file, a wrong or symlinked device node, an occupied loop slot or a file
 * attached elsewhere; then it pins the device node's owner and mode and keeps
 * running, so the provisioner is Ready exactly while the disk is attached.
 *
 * Values are replaced in one pass, so a target value is never rewritten as
 * another reference value.
 */
export function provisionScript(props: ProvisionScriptProps): string {
  const target = validDisk(props, WHERE);
  const template = props.template ?? defaultProvisionTemplate();
  if (typeof template?.script !== "string") throw new TypeError(`${WHERE}: template.script must be a string`);
  const reference = validDisk(template.reference, `${WHERE}: template.reference`);
  const from = tokens(reference), to = tokens(target);
  for (const token of from) {
    if (!template.script.includes(token)) throw new TypeError(`${WHERE}: the template does not contain its reference value ${JSON.stringify(token)}`);
    if (from.some(other => other !== token && other.includes(token))) {
      throw new TypeError(`${WHERE}: reference value ${JSON.stringify(token)} is part of another reference value`);
    }
  }
  const replacement = new Map(from.map((token, i) => [token, to[i]]));
  const pattern = new RegExp([...from].sort((a, b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "g");
  const script = template.script.replace(pattern, token => replacement.get(token)!);
  if (props.placeholderMagic === undefined) return script;
  const { printf, sha256 } = placeholderSector(props.placeholderMagic);
  if (script.split(CREATED).length !== 2 || script.split(UNCHANGED).length !== 2) {
    throw new TypeError(`${WHERE}: a placeholder needs the template's file creation and backing-file check exactly once`);
  }
  return script.replace(CREATED, () => `(set -C; printf '${printf}' > "$file")`).replace(UNCHANGED, () => UNCHANGED
    + `[ "$(head -c 512 "$file" | sha256sum | cut -d' ' -f1)" = '${sha256}' ] || {\n`
    + "  echo 'refusing changed stage placeholder'; exit 1;\n}\n");
}
