import { readFileSync } from "node:fs";

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8");

function label(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("script log prefix must be a plain label");
  return value;
}

function path(value: string, absolute: boolean): string {
  if (!/^[a-zA-Z0-9/._-]+$/.test(value) || value.startsWith("/") !== absolute
    || value.split("/").slice(absolute ? 1 : 0).some(part => !part || part === "." || part === "..")) {
    throw new Error(`script path must be a plain ${absolute ? "absolute" : "relative"} path`);
  }
  return value;
}

export function loopbackVolumeGroupScript(options: { logPrefix: string }): string {
  return asset("loopback-volume-group.sh").replaceAll("__LOG_PREFIX__", label(options.logPrefix));
}

export function packageFreezeScript(): string {
  return asset("package-freeze.sh");
}

export interface HostKernelPinScriptOptions {
  /** Relative to the host root; a GRUB defaults drop-in. */
  pinFile: string;
  /** Literal comment written above GRUB_DEFAULT; changing it rewrites the pin. */
  provenance: string;
}

export function kernelPinScript(options: HostKernelPinScriptOptions): string {
  if (!/^etc\/default\/grub\.d\/[a-zA-Z0-9._-]+\.cfg$/.test(options.pinFile)) throw new Error("kernel pin file must be a GRUB defaults drop-in");
  // POSIX echo implementations may expand backslash escapes in their input.
  // Refuse them so a comment cannot become a second GRUB directive.
  if (!options.provenance || /[\\\r\n\0]/.test(options.provenance)) throw new Error("kernel pin provenance must be one nonempty line without backslashes");
  const provenance = options.provenance.replace(/[\\"$`]/g, character => `\\${character}`);
  const pinFile = path(options.pinFile, false);
  return asset("kernel-pin.sh").replace(/__PIN_FILE__|__PROVENANCE__/g,
    token => token === "__PIN_FILE__" ? pinFile : provenance);
}

export function hostConfigurationPolicyScript(): string {
  return asset("host-policy.sh");
}

export interface PinnedLoopAttachScriptOptions {
  backingDirectory: string;
  logPrefix: string;
}

/** Existing sparse files are never truncated. PORTAL_LOOP_POOL and
 * PORTAL_VOLUMES retain the script's established environment contract. */
export function pinnedLoopAttachScript(options: PinnedLoopAttachScriptOptions): string {
  const directory = path(options.backingDirectory, true), logPrefix = label(options.logPrefix);
  return asset("pinned-loop-attach.sh").replace(/__BACKING_DIRECTORY__|__LOG_PREFIX__/g,
    token => token === "__BACKING_DIRECTORY__" ? directory : logPrefix);
}
