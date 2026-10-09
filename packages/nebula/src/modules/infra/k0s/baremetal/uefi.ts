/** Offsets are relative to the variable payload, excluding efivarfs's attribute header. */
export type BaremetalUefiParameter = {
  name: string;
  offset: number;
  width: 1 | 2 | 4;
  /** Unsigned little-endian value. */
  value: number;
} & ({ allowedValues: number[]; range?: never } | { range: { min: number; max: number }; allowedValues?: never });

export interface BaremetalUefiVariable {
  name: string;
  guid: string;
  /** Exact byte count excluding the four-byte efivarfs attribute header. */
  payloadSize: number;
  /** Nonvolatile, boot-service and runtime access. Authenticated variables are unsupported. */
  attributes: 7;
  parameters: BaremetalUefiParameter[];
}

/** Firmware layouts must be qualified for this exact board and BIOS release. */
export interface BaremetalUefiConfiguration {
  match: { boardVendor: string; boardName: string; biosVersion: string; biosVendor?: string };
  variables: BaremetalUefiVariable[];
  /** Bounds configuration and the firmware reboot; defaults to 900 seconds. */
  rebootTimeoutSeconds?: number;
  /** Check effective capabilities on the installed OS before publishing the worker. */
  verification?: {
    cpuFlags?: string[];
    moduleParameters?: { module: string; parameter: string; value: string }[];
  };
}

export function validateUefi(p: BaremetalUefiConfiguration): void {
  const requireValue = (ok: unknown, message: string): void => {
    if (!ok) throw new Error(`Baremetal UEFI: ${message}`);
  };
  const uint = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;
  for (const key of ["boardVendor", "boardName", "biosVersion"] as const)
    requireValue(typeof p.match?.[key] === "string" && /^[\x20-\x7e]{1,128}$/.test(p.match[key]), `exact ${key} match is required`);
  requireValue(Object.keys(p.match).every(key => ["boardVendor", "boardName", "biosVersion", "biosVendor"].includes(key)), "unknown hardware identity field");
  requireValue(p.match.biosVendor === undefined || /^[\x20-\x7e]{1,128}$/.test(p.match.biosVendor), "invalid BIOS vendor");
  requireValue(p.rebootTimeoutSeconds === undefined || (uint(p.rebootTimeoutSeconds, 7200) && p.rebootTimeoutSeconds >= 60), "reboot deadline must be 60–7200 seconds");
  requireValue(Array.isArray(p.variables) && p.variables.length > 0 && p.variables.length <= 16, "declare 1–16 variables");
  const variables = new Set<string>();
  for (const variable of p.variables) {
    requireValue(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(variable.name), "invalid variable name");
    requireValue(/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(variable.guid), "invalid variable GUID");
    const key = variable.name;
    requireValue(!variables.has(key), "setup_var.efi requires unique variable names"); variables.add(key);
    requireValue(uint(variable.payloadSize, 65536) && variable.payloadSize > 0 && variable.attributes === 7, "require an exact payload size and NV/BS/RT attributes (7)");
    requireValue(Array.isArray(variable.parameters) && variable.parameters.length > 0 && variable.parameters.length <= 64, "declare 1–64 parameters per variable");
    const occupied = new Set<number>();
    const names = new Set<string>();
    for (const parameter of variable.parameters) {
      requireValue(/^[\x20-\x7e]{1,128}$/.test(parameter.name) && !names.has(parameter.name), "parameter names must be unique"); names.add(parameter.name);
      requireValue([1, 2, 4].includes(parameter.width) && uint(parameter.offset, variable.payloadSize) && parameter.offset + parameter.width <= variable.payloadSize, "parameter exceeds the variable payload");
      for (let i = parameter.offset; i < parameter.offset + parameter.width; i++) {
        requireValue(!occupied.has(i), "overlapping parameters"); occupied.add(i);
      }
      const max = 2 ** (8 * parameter.width) - 1;
      requireValue(uint(parameter.value, max), "parameter value exceeds its width");
      requireValue(Boolean(parameter.allowedValues) !== Boolean(parameter.range), "declare legal values or a legal range");
      if (parameter.allowedValues) {
        requireValue(parameter.allowedValues.length > 0 && parameter.allowedValues.length <= 64
          && parameter.allowedValues.every(v => uint(v, max)) && parameter.allowedValues.includes(parameter.value), "invalid legal values");
      } else if (parameter.range) {
        requireValue(uint(parameter.range.min, max) && uint(parameter.range.max, max)
          && parameter.range.min <= parameter.value && parameter.value <= parameter.range.max, "invalid legal range");
      }
    }
  }
  for (const flag of p.verification?.cpuFlags ?? [])
    requireValue(/^[a-z0-9_]{1,64}$/.test(flag), "invalid CPU flag");
  for (const check of p.verification?.moduleParameters ?? [])
    requireValue(/^[a-zA-Z0-9_]{1,64}$/.test(check.module) && /^[a-zA-Z0-9_]{1,64}$/.test(check.parameter)
      && /^[A-Za-z0-9_,.+-]{1,128}$/.test(check.value), "invalid kernel module parameter check");
  requireValue((p.verification?.cpuFlags?.length ?? 0) <= 64 && (p.verification?.moduleParameters?.length ?? 0) <= 64, "too many verification checks");
}
