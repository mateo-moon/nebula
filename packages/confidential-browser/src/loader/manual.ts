import { bytes, hash, b64, utf8, snpPolicy, type SnpIdentity } from "./transport";
import { newOwner, restoreBackup, encryptedOwnerVault, saveEncryptedOwner, type OwnerState } from "./owner";

export interface CertificateRecord {
  version: number; certificateDer: string; certificateSha256: string; publicKeySha256: string;
  notBefore: string; notAfter: string; provenance: string;
}
export interface ManualSession {
  owner: OwnerState; certificate: CertificateRecord;
  save(owner: OwnerState): Promise<unknown>;
  backup(owner: OwnerState, password: string): Promise<unknown>;
  password(): string;
}

export function certificateDer(value: Uint8Array): Uint8Array {
  if (!value.length || value.length > 100_000) throw new Error("Choose a browser-exported certificate smaller than 100 KiB");
  const text = new TextDecoder().decode(value).trim();
  const label = "CERTIFICATE", begin = `-----BEGIN ${label}-----`, end = `-----END ${label}-----`;
  if (text.startsWith(begin)) {
    const content = text.slice(begin.length, -end.length);
    if (!text.endsWith(end) || !/^[A-Za-z0-9+/=\s]+$/.test(content)) throw new Error("Export one certificate in PEM or DER format");
    value = bytes(content.replace(/\s/g, ""));
  }
  if (value.length > 65536) throw new Error("Certificate exceeds 64 KiB");
  return value;
}
export function manualFragment(fragment: string) {
  // Do not accept or persist even legacy bootstrap credentials on this origin.
  if (fragment && new URLSearchParams(fragment.replace(/^#/, "")).toString()) {
    throw new Error("Use the endpoint without a URL fragment. Enter the access token only after independent verification");
  }
}
export async function appraiseExportedCertificate(raw: Uint8Array, record: CertificateRecord, identity: SnpIdentity,
  verify: (der: Uint8Array, policy: unknown) => Promise<any>) {
  const der = certificateDer(raw);
  const fingerprint = await hash(der);
  const result = await verify(der, { model: "background_check", as_provider: "coco", as_type: "builtin",
    attestation_policy: { type: "inline", content: b64(utf8(snpPolicy(identity))) }, reference_values: [] });
  // Evidence refresh can renew the listener certificate while a browser's
  // existing connection still uses its earlier, valid certificate. Appraise
  // the exported bytes and require the same guest-held public key.
  if (result.certificate_sha256 !== fingerprint || result.public_key_sha256 !== record.publicKeySha256) {
    throw new Error("Verified certificate/public-key binding differs");
  }
  return result;
}

export async function manualSession(target: string, sdk: () => Promise<any>, hardware: Omit<SnpIdentity, "initDataSha256">): Promise<ManualSession> {
  const section = document.getElementById("tls-verification")!; section.hidden = false;
  const output = document.getElementById("tls-details")!;
  const response = await fetch("/nebula/v1/tls", { credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok) throw new Error("The guest's public certificate is unavailable");
  const record: CertificateRecord = await response.json();
  if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.certificateSha256) || !/^[a-f0-9]{64}$/.test(record.publicKeySha256) ||
      await hash(bytes(record.certificateDer)) !== record.certificateSha256) throw new Error("Invalid guest certificate metadata");
  output.textContent = JSON.stringify({ ...record, certificateDer: "Download the certificate or export it through the browser's certificate viewer" }, null, 2);
  (document.getElementById("tls-measurement") as HTMLInputElement).value = hardware.measurement;
  document.getElementById("certificate-check")!.addEventListener("submit", event => {
    event.preventDefault();
    const button = document.getElementById("check-certificate") as HTMLButtonElement;
    const result = document.getElementById("certificate-result")!; button.disabled = true;
    void (async () => {
      const file = (document.getElementById("browser-certificate") as HTMLInputElement).files?.[0];
      const pasted = (document.getElementById("browser-certificate-text") as HTMLTextAreaElement).value.trim();
      if ((!file && !pasted) || (file && pasted) || (file && file.size > 100_000)) throw new Error("Choose one browser-exported certificate file, or paste its PEM certificate");
      const identity = { ...hardware, measurement: (document.getElementById("tls-measurement") as HTMLInputElement).value.trim(),
        initDataSha256: (document.getElementById("tls-policy") as HTMLInputElement).value.trim() };
      const raw = file ? new Uint8Array(await file.arrayBuffer()) : utf8(pasted);
      const verified = await appraiseExportedCertificate(raw, record, identity, (await sdk()).verify_certificate);
      result.textContent = "The browser-exported certificate passed the supplied policy and matches the guest's current public key. Certificate renewals may change its fingerprint. This served checker is a convenience; it cannot independently authenticate itself.\n" + JSON.stringify(verified, null, 2);
    })().catch(error => { result.textContent = error instanceof Error ? error.message : "Certificate appraisal failed"; })
      .finally(() => { button.disabled = false; });
  });
  await new Promise<void>(resolve => document.getElementById("manual-verification")!.addEventListener("submit", event => {
    event.preventDefault();
    if ((document.getElementById("independently-verified") as HTMLInputElement).checked) resolve();
  }, { once: true }));
  (document.getElementById("manual-verification") as HTMLFormElement).hidden = true;
  const form = document.getElementById("manual-owner") as HTMLFormElement; form.hidden = false;
  const stored = encryptedOwnerVault(target);
  const token = document.getElementById("claim-token") as HTMLInputElement;
  token.required = !stored; token.closest("label")!.hidden = !!stored;
  document.getElementById("manual-recovery")!.addEventListener("change", event => {
    token.required = !stored && !(event.target as HTMLInputElement).files?.length;
  });
  const login = document.getElementById("owner-login-status")!;
  return await new Promise<ManualSession>(resolve => form.addEventListener("submit", event => {
    event.preventDefault();
    const submit = document.getElementById("unlock-owner") as HTMLButtonElement; submit.disabled = true;
    void (async () => {
      let password = (document.getElementById("vault-password") as HTMLInputElement).value;
      if (password.length < 12) throw new Error("Use an owner/recovery password of at least 12 characters");
      const recovery = (document.getElementById("manual-recovery") as HTMLInputElement).files?.[0];
      if (recovery && recovery.size > 16 * 1024 * 1024) throw new Error("Recovery file is too large");
      const owner = recovery ? await restoreBackup(await recovery.text(), password) : stored ? await restoreBackup(stored, password) : await newOwner();
      if (!stored && !recovery) {
        if (!/^[a-f0-9]{64}$/.test(token.value)) throw new Error("Enter the one-time access token separately from the URL");
        owner.token = token.value;
      }
      token.value = ""; (document.getElementById("vault-password") as HTMLInputElement).value = "";
      form.hidden = true;
      resolve({ owner, certificate: record, password: () => password,
        save: value => saveEncryptedOwner(target, value, password),
        backup: async (value, nextPassword) => { const result = await saveEncryptedOwner(target, value, nextPassword); password = nextPassword; return result; } });
    })().catch(error => { login.textContent = error instanceof Error ? error.message : "Owner access failed"; })
      .finally(() => { submit.disabled = false; });
  }));
}
