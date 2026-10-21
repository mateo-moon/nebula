import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { TrusteeResourcePath } from "../trustee/policies";

const annotation = "org.opencontainers.image.enc.keys.provider.attestation-agent";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export class ConfidentialPublicationPending extends Error {
  constructor() { super("Confidential workload: encrypted publication is not yet available"); }
}

/** Inspect the exact encrypted manifest before creating a measured Pod. The
 * registry is an untrusted source: only the resulting digest enters policy. */
export function encryptedManifestDigest(raw: Buffer, resource: TrusteeResourcePath): string {
  if (raw.length > 4 * 1024 * 1024) throw new Error("Encrypted OCI manifest exceeds limit");
  let manifest: any;
  try { manifest = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("Invalid encrypted OCI manifest"); }
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length === 0 ||
      manifest.layers.length > 256) throw new Error("Expected a single encrypted OCI image manifest");
  const expected = `kbs:///${resource.join("/")}`;
  for (const layer of manifest.layers) {
    const value = layer?.annotations?.[annotation];
    if (typeof layer?.mediaType !== "string" || !layer.mediaType.endsWith("+encrypted") ||
        typeof value !== "string" || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("Every OCI layer must be encrypted to the declared key");
    }
    let key: any;
    try { key = JSON.parse(Buffer.from(value, "base64").toString("utf8")); }
    catch { throw new Error("Invalid OCI encryption annotation"); }
    if (key?.kid !== expected) throw new Error("OCI layer uses another key resource");
  }
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function resolvePublishedImage(tag: string, resource: TrusteeResourcePath, expected?: string): string {
  if (expected !== undefined && !digestPattern.test(expected)) throw new Error("Invalid approved image digest");
  // The owner publisher has already verified every ciphertext layer and the
  // registry digest. Measuring its receipt avoids needing registry credentials
  // in the independent owner verifier. The operator always resolves afresh.
  if (expected !== undefined) return `${tag.slice(0, tag.lastIndexOf(":"))}@${expected}`;
  let raw: Buffer;
  try {
    raw = execFileSync("skopeo", ["--insecure-policy", "inspect", "--raw", `docker://${tag}`],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    throw new ConfidentialPublicationPending();
  }
  const digest = encryptedManifestDigest(raw, resource);
  return `${tag.slice(0, tag.lastIndexOf(":"))}@${digest}`;
}
