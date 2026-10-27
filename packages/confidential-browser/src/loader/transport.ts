export interface SnpIdentity {
  measurement: string; initDataSha256: string; chipId?: string;
  minimumReportedTcb: { bootloader: number; tee: number; snp: number; microcode: number };
}
export interface VerifiedResponse extends Response {
  attest_info: { server_public_key: string; attestation_result: string };
}
export type AttestedFetch = (url: string, init: RequestInit, config: unknown) => Promise<VerifiedResponse>;
export const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
export function b64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 16384) result += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(result);
}
export const bytes = (encoded: string) => Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
export const utf8 = (text: string) => new TextEncoder().encode(text);
export const hash = async (value: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value as BufferSource)));

/** Only pinned release policy may reach the SDK. Nothing from discovery may
 * select an external AS, trust_all, hardware_only or a caller-supplied Rego. */
export function snpPolicy(identity: SnpIdentity): string {
  if (!/^[a-f0-9]{96}$/.test(identity.measurement) || !/^[a-f0-9]{64}$/.test(identity.initDataSha256) ||
      (identity.chipId !== undefined && !/^[a-f0-9]{128}$/.test(identity.chipId))) throw new Error("Invalid expected SNP identity");
  const floors = identity.minimumReportedTcb;
  if (Object.keys(floors).sort().join() !== "bootloader,microcode,snp,tee" || Object.values(floors).some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error("Invalid TCB floor");
  const measurement = b64(Uint8Array.from(identity.measurement.match(/../g)!, c => parseInt(c, 16)));
  return `package policy
default trust_claims := {"executables": 33, "hardware": 97, "configuration": 36}
extensions := []
trust_claims := {"executables": 3, "hardware": 2, "configuration": 2} if {
  input.init_data == ${JSON.stringify(identity.initDataSha256)}
  input.snp.measurement == ${JSON.stringify(measurement)}
  input.snp.policy_debug_allowed == "0"
  input.snp.policy_migrate_ma == "0"
  ${identity.chipId ? `input.snp.chip_id == ${JSON.stringify(identity.chipId)}` : ""}
  ${Object.entries(floors).map(([field, minimum]) => `to_number(input.snp.reported_tcb_${field}) >= ${minimum}`).join("\n  ")}
}`;
}

export function endpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new Error("Use an HTTPS stack endpoint");
  return url.origin;
}

export class AttestedChannel {
  public lastAttestation?: VerifiedResponse["attest_info"];
  public pin?: string;
  readonly origin: string;
  constructor(readonly fetcher: AttestedFetch, origin: string, readonly identity: SnpIdentity, pin?: string) {
    this.origin = endpoint(origin + (origin.endsWith("/") ? "" : "/"));
    if (pin !== undefined && !/^[a-f0-9]{64}$/.test(pin)) throw new Error("Invalid instance pin");
    this.pin = pin;
  }
  async request(path: string, init: RequestInit = {}): Promise<VerifiedResponse> {
    if (!/^\/[A-Za-z0-9/._-]*$/.test(path) || path.includes("..")) throw new Error("Invalid attested API path");
    if (!this.pin && (init.method ?? "GET") !== "GET") throw new Error("Enroll the instance before sending a secret");
    const response = await this.fetcher(this.origin + path, { ...init, credentials: "omit", redirect: "error", cache: "no-store" }, {
      ohttp: { ...(this.pin ? { expected_server_public_key: this.pin } : {}) },
      verify: { model: "background_check", as_provider: "coco", as_type: "builtin",
        attestation_policy: { type: "inline", content: snpPolicy(this.identity) }, reference_values: [] },
    });
    const info = response.attest_info;
    if (!info || !/^[a-f0-9]{64}$/.test(info.server_public_key) || !info.attestation_result ||
        (this.pin && this.pin !== info.server_public_key)) throw new Error("Verified instance key is missing or changed");
    this.pin ??= info.server_public_key;
    this.lastAttestation = info;
    return response;
  }
}
