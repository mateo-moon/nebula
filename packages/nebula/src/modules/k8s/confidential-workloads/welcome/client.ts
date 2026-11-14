// This ordinary-HTTPS guide displays reported data; it never verifies attestation.
export {};

type Reference = Readonly<{
  measurement: string;
  initDataSha256: string;
  minimumReportedTcb: Readonly<{ bootloader: number; tee: number; snp: number; microcode: number }>;
  releaseUrl?: string;
}>;
type Configuration = Readonly<{ portalUrl: string; reference?: Reference }>;
type ReportedCertificate = Readonly<{
  version: 1;
  verification: "unverified";
  certificateDer: string;
  certificateSha256: string;
  publicKeySha256: string;
  notBefore: string;
  notAfter: string;
  retrievedAt: string;
  provenance: string;
}>;
type Snapshot = Readonly<{ configuration: Configuration; certificate: ReportedCertificate; der: Uint8Array }>;

const MAX_CERTIFICATE_BYTES = 64 * 1024;
const MAX_CERTIFICATE_JSON_BYTES = 128 * 1024;
const INVALID = "Invalid reported portal details";
const el = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing welcome-page element");
  return value as T;
};
const refreshButton = el<HTMLButtonElement>("refresh");
const certificateButton = el<HTMLButtonElement>("download-certificate");
const evidenceButton = el<HTMLButtonElement>("download-evidence");
const portalLink = el<HTMLAnchorElement>("portal-link");
let snapshot: Snapshot | undefined;
let generation = 0;
let pending: AbortController | undefined;

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const fields = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(fields, key)) || Object.keys(fields).some(key => !required.includes(key) && !optional.includes(key))) throw new Error(INVALID);
  return fields;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error(INVALID);
  return value;
}
function hex(value: unknown, length: number): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) throw new Error(INVALID);
  return value;
}
function httpsUrl(value: unknown, portal = false): string {
  const input = text(value, 2048);
  if (input.trim() !== input || input.includes("?") || input.includes("#")) throw new Error(INVALID);
  const url = new URL(input);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || (portal && url.pathname !== "/") || url.href.length > 2048) throw new Error(INVALID);
  return url.href;
}
function reference(value: unknown): Reference {
  const fields = object(value, ["measurement", "initDataSha256", "minimumReportedTcb"], ["releaseUrl"]);
  const tcb = object(fields.minimumReportedTcb, ["bootloader", "tee", "snp", "microcode"]);
  for (const value of Object.values(tcb)) if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) throw new Error(INVALID);
  return Object.freeze({ measurement: hex(fields.measurement, 96), initDataSha256: hex(fields.initDataSha256, 64),
    minimumReportedTcb: Object.freeze({ bootloader: tcb.bootloader as number, tee: tcb.tee as number, snp: tcb.snp as number, microcode: tcb.microcode as number }),
    ...(fields.releaseUrl === undefined ? {} : { releaseUrl: httpsUrl(fields.releaseUrl) }) });
}
function configuration(value: unknown): Configuration {
  const fields = object(value, ["portalUrl"], ["reference"]);
  return Object.freeze({ portalUrl: httpsUrl(fields.portalUrl, true), ...(fields.reference === undefined ? {} : { reference: reference(fields.reference) }) });
}
function iso(value: unknown): string {
  const result = text(value, 32);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) throw new Error(INVALID);
  return result;
}
function reportedCertificate(value: unknown): ReportedCertificate {
  const fields = object(value, ["version", "verification", "certificateDer", "certificateSha256", "publicKeySha256", "notBefore", "notAfter", "retrievedAt", "provenance"]);
  if (fields.version !== 1 || fields.verification !== "unverified") throw new Error(INVALID);
  const notBefore = iso(fields.notBefore), notAfter = iso(fields.notAfter), retrievedAt = iso(fields.retrievedAt);
  if (Date.parse(notBefore) >= Date.parse(notAfter)) throw new Error(INVALID);
  return Object.freeze({ version: 1, verification: "unverified", certificateDer: text(fields.certificateDer, 4 * Math.ceil(MAX_CERTIFICATE_BYTES / 3)),
    certificateSha256: hex(fields.certificateSha256, 64), publicKeySha256: hex(fields.publicKeySha256, 64),
    notBefore, notAfter, retrievedAt, provenance: text(fields.provenance, 2048) });
}
function certificateBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(INVALID);
  const decoded = atob(value);
  if (decoded.length < 64 || decoded.length > MAX_CERTIFICATE_BYTES || btoa(decoded) !== value) throw new Error(INVALID);
  const der = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (der[0] !== 0x30) throw new Error(INVALID);
  let length = der[1], offset = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || der[2] === 0 || offset + count >= der.length) throw new Error(INVALID);
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + der[offset++];
    if (length < 128) throw new Error(INVALID);
  }
  if (offset + length !== der.length) throw new Error(INVALID);
  return der;
}
async function json(path: "/config.json" | "/api/certificate", maximum: number, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "GET", credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store",
    referrerPolicy: "no-referrer", headers: { Accept: "application/json" }, signal });
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error(INVALID);
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) throw new Error(INVALID);
  if (!response.body) throw new Error(INVALID);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) throw new Error(INVALID);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function clear() {
  snapshot = undefined;
  certificateButton.disabled = true; evidenceButton.disabled = true;
  portalLink.removeAttribute("href"); portalLink.setAttribute("aria-disabled", "true"); portalLink.setAttribute("tabindex", "-1"); portalLink.classList.add("disabled");
  el("portal-address").textContent = "Portal details unavailable";
  for (const id of ["certificate-fingerprint", "public-key-fingerprint", "certificate-not-before", "certificate-not-after", "certificate-retrieved-at"]) {
    el(id).textContent = "—"; el(id).removeAttribute("datetime");
  }
  el("certificate-provenance").textContent = "No current snapshot is available.";
  el("reference-details").hidden = true; el("no-reference").hidden = true;
  el("release-link").hidden = true; el("release-link").removeAttribute("href");
  for (const id of ["reference-measurement", "reference-init-data", "reference-tcb"]) el(id).textContent = "";
}
function display(value: Snapshot) {
  portalLink.href = value.configuration.portalUrl; portalLink.removeAttribute("aria-disabled"); portalLink.removeAttribute("tabindex"); portalLink.classList.remove("disabled");
  el("portal-address").textContent = value.configuration.portalUrl;
  const cert = value.certificate;
  const fingerprint = (value: string) => value.match(/../g)!.join(":").toUpperCase();
  el("certificate-fingerprint").textContent = fingerprint(cert.certificateSha256);
  el("public-key-fingerprint").textContent = fingerprint(cert.publicKeySha256);
  for (const [id, value] of [["certificate-not-before", cert.notBefore], ["certificate-not-after", cert.notAfter], ["certificate-retrieved-at", cert.retrievedAt]]) {
    el(id).textContent = new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
    el(id).setAttribute("datetime", value);
  }
  el("certificate-provenance").textContent = cert.provenance;
  const ref = value.configuration.reference;
  el("reference-details").hidden = !ref; el("no-reference").hidden = !!ref;
  if (ref) {
    el("reference-measurement").textContent = ref.measurement; el("reference-init-data").textContent = ref.initDataSha256;
    const tcb = ref.minimumReportedTcb;
    el("reference-tcb").textContent = `Bootloader ${tcb.bootloader} · TEE ${tcb.tee} · SNP ${tcb.snp} · Microcode ${tcb.microcode}`;
    if (ref.releaseUrl) { const release = el<HTMLAnchorElement>("release-link"); release.href = ref.releaseUrl; release.hidden = false; }
  }
  certificateButton.disabled = false; evidenceButton.disabled = false;
}
async function refresh() {
  const current = ++generation;
  pending?.abort(); const controller = new AbortController(); pending = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  clear(); refreshButton.disabled = true;
  const status = el("certificate-status"); status.textContent = "Loading reported certificate…"; status.dataset.state = "loading";
  try {
    const [configValue, certificateValue] = await Promise.all([json("/config.json", 16 * 1024, controller.signal), json("/api/certificate", MAX_CERTIFICATE_JSON_BYTES, controller.signal)]);
    const config = configuration(configValue), cert = reportedCertificate(certificateValue), der = certificateBytes(cert.certificateDer);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(der).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== cert.certificateSha256) throw new Error(INVALID);
    if (current !== generation || controller.signal.aborted) return;
    snapshot = Object.freeze({ configuration: config, certificate: cert, der });
    display(snapshot); status.textContent = "Reported snapshot loaded. Independent verification is still required."; status.dataset.state = "ready";
  } catch {
    if (current !== generation) return;
    controller.abort();
    clear(); status.textContent = "Couldn’t load current portal details. Refresh to try again."; status.dataset.state = "error";
  } finally {
    clearTimeout(timeout);
    if (current === generation) { refreshButton.disabled = false; pending = undefined; }
  }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.rel = "noopener noreferrer";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
refreshButton.addEventListener("click", () => { void refresh(); });
certificateButton.addEventListener("click", () => {
  const current = snapshot;
  if (!current || certificateButton.disabled) return;
  download(new Blob([current.der.slice().buffer], { type: "application/pkix-cert" }), `nebula-portal-certificate-${current.certificate.certificateSha256.slice(0, 12)}.der`);
});
evidenceButton.addEventListener("click", () => {
  const current = snapshot;
  if (!current || evidenceButton.disabled) return;
  const bundle = { version: 1, verification: "unverified", portalUrl: current.configuration.portalUrl,
    ...(current.configuration.reference ? { reference: current.configuration.reference } : {}), certificate: current.certificate };
  download(new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }), `nebula-portal-evidence-${current.certificate.certificateSha256.slice(0, 12)}.json`);
});
void refresh();
