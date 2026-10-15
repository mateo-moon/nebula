/** Same repository/type/tag tuple used by the native KBS resource protocol. */
export type TrusteeResourcePath = readonly [string, string, string];

/** An exact approved SNP launch/configuration pair, never two independent lists. */
export interface TrusteeSnpIdentity {
  readonly measurement: string;
  readonly initDataSha256: string;
  /** Signed hardware identity of an independently reviewed platform. */
  readonly chipId: string;
  readonly minimumReportedTcb: {
    readonly bootloader: number;
    readonly tee: number;
    readonly snp: number;
    readonly microcode: number;
  };
}

export interface TrusteeResourceAdmission {
  readonly path: TrusteeResourcePath;
  readonly recipients: readonly TrusteeSnpIdentity[];
}

export interface TrusteePolicies {
  readonly resourcePolicy: string;
  readonly attestationPolicy: string;
}

export function resourcePath(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part =>
    typeof part === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(part))) {
    throw new TypeError("Trustee: resource paths require exactly three plain repository/type/tag segments");
  }
  return value.join("/");
}

export function snpIdentity(value: TrusteeSnpIdentity): TrusteeSnpIdentity {
  for (const [field, length] of [["measurement", 96], ["initDataSha256", 64], ["chipId", 128]] as const) {
    if (typeof value?.[field] !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value[field]) || /^0+$/.test(value[field])) {
      throw new TypeError(`Trustee: ${field} requires a nonzero lowercase hex digest of length ${length}`);
    }
  }
  const floors = value.minimumReportedTcb;
  const names = ["bootloader", "tee", "snp", "microcode"] as const;
  if (!floors || Object.keys(floors).sort().join() !== [...names].sort().join() || names.some(key =>
    !Number.isInteger(floors[key]) || floors[key] < 0 || floors[key] > 255)) {
    throw new TypeError("Trustee: all four minimumReportedTcb components must be explicit bytes");
  }
  return { measurement: value.measurement, initDataSha256: value.initDataSha256, chipId: value.chipId,
    minimumReportedTcb: { bootloader: floors.bootloader, tee: floors.tee, snp: floors.snp, microcode: floors.microcode } };
}

// These claim names and AR4SI values follow the built-in Trustee SNP verifier
// and the existing AttestedPullBroker policy contract. Signature, nonce, VMPL
// and report-data binding verification happen in AS before this appraisal.
const MATCH = `approved_snp(ev, identity) if {
    ev.init_data == identity.initDataSha256
    ev.snp.measurement == identity.measurement
    ev.snp.chip_id == identity.chipId
    ev.snp.policy_debug_allowed == false
    ev.snp.policy_migrate_ma == false
    every component, minimum in identity.minimumReportedTcb {
        actual := ev.snp[concat("", ["reported_tcb_", component])]
        is_number(actual)
        actual == floor(actual)
        actual >= minimum
        actual <= 255
    }
}
`;

/** Strict CPU-only release policies for Trustee's built-in AS / EAR tokens. */
export function trusteePolicies(admissions: readonly TrusteeResourceAdmission[]): TrusteePolicies {
  if (!Array.isArray(admissions) || admissions.length === 0 || admissions.length > 64) {
    throw new TypeError("Trustee: supply between one and 64 resource admissions");
  }
  const paths = new Set<string>();
  const approved = admissions.map(admission => {
    const path = resourcePath(admission.path);
    if (paths.has(path)) throw new TypeError("Trustee: duplicate resource path");
    paths.add(path);
    if (!Array.isArray(admission.recipients) || !admission.recipients.length || admission.recipients.length > 32) {
      throw new TypeError("Trustee: every resource needs between one and 32 approved recipients");
    }
    return { path: [...admission.path], recipients: admission.recipients.map(snpIdentity) };
  });
  const identities = [...new Map(approved.flatMap(item => item.recipients)
    .map(identity => [JSON.stringify(identity), identity])).values()];
  return {
    resourcePolicy: `package policy
default allow := false
allow if {
    data.plugin == "resource"
    count(input.submods) == 1
    input.submods.cpu0["ear.status"] == "affirming"
    ev := input.submods.cpu0["ear.veraison.annotated-evidence"]
    some resource in approved_resources
    data["resource-path"] == resource.path
    some identity in resource.recipients
    approved_snp(ev, identity)
}
${MATCH}
approved_resources := ${JSON.stringify(approved, null, 2)}
`,
    attestationPolicy: `package policy
default trust_claims := {"executables": 33, "hardware": 97, "configuration": 36}
extensions := []
trust_claims := {"executables": 3, "hardware": 2, "configuration": 2} if {
    some identity in approved_identities
    approved_snp(input, identity)
}
${MATCH}
approved_identities := ${JSON.stringify(identities, null, 2)}
`,
  };
}
