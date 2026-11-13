import { closeSync, constants, fstatSync, openSync, readSync, statfsSync } from "node:fs";
import { request } from "node:http";

const LOG = "/run/kbs-diagnostics/kbs.log";
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 512;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** Preset-owner gateways rely on KBS to verify the owner's JWT. Validate only
 * its fixed owner policy route; discard every response byte. */
export function kbsOwnerAuthorized(authorization: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let size = 0;
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/kbs/v0/resource-policy", agent: false,
      headers: { Authorization: authorization } }, response => {
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        chunk.fill(0);
        if (size > 2 * 1024 * 1024) req.destroy();
      });
      response.once("end", () => resolve(response.statusCode === 200 && size <= 2 * 1024 * 1024));
      response.once("error", () => resolve(false));
      response.once("aborted", () => resolve(false));
    });
    req.setTimeout(5_000, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

// These are observations of native log messages, never an attestation verdict.
// The response contains no copied log text, paths, claims, key material or JWTs.
const categories = {
  startup: /^Error:|HTTPFailed|HTTPSFailed|Initialization|initializ.*failed/i,
  ownerAuthorization: /AdminAuthAccess|AdminAuthInitialization/,
  attestationHandshake: /RcarAuthFailed|RcarAttestFailed|RCAR handshake|SessionStorageError/,
  evidenceVerification: /Verifier evaluate failed|Deserialize SNP Evidence failed|Deserialize Quote failed|Report Data Mismatch|Host Data Mismatch|Chip ID mismatch|[Ss]ignature.*(?:invalid|failed)|VMPL Check Failed|TCB.*mismatch/,
  collateral: /VCEK|VLEK|KDS|endorsement|Vendor certs|certificate chain/i,
  attestationPolicy: /[Aa]ttestation [Pp]olicy|[Pp]olicy.*(?:[Ee]valuation|[Aa]ppraisal)|[Tt]rust.*[Cc]laims/,
  attestationToken: /TokenVerifierError|TokenVerificationFailed|TokenVerifierInitialization|TokenNotFound|TeePubKey|[Aa]ttestation [Tt]oken/,
  resourcePolicy: /PolicyDeny|PolicyEngineError|ParsePolicyError|Access denied by policy/,
  resourceStorage: /PluginInternalError|PluginManagerInitialization|StorageBackendInitialization|[Rr]esource.*(?:not found|does not exist)/,
  responseEncryption: /JweError|JWE failed/,
};

function empty() {
  return { available: false, truncated: false, bytesScanned: 0, linesScanned: 0,
    categories: { startup: 0, ownerAuthorization: 0, attestationHandshake: 0, evidenceVerification: 0,
      collateral: 0, attestationPolicy: 0, attestationToken: 0, resourcePolicy: 0,
      resourceStorage: 0, responseEncryption: 0, unclassified: 0 } };
}

/** Classify a bounded snapshot. A line may match more than one category;
 * counts describe matching lines in this window, not unique requests. */
function classify(bytes: Buffer, cutFirstLine: boolean) {
  const result = empty();
  result.available = true;
  result.bytesScanned = bytes.length;
  let text = bytes.toString("utf8");
  if (cutFirstLine) {
    const newline = text.indexOf("\n");
    text = newline < 0 ? "" : text.slice(newline + 1);
    result.truncated = true;
  }
  const end = text.lastIndexOf("\n");
  if (end !== text.length - 1) result.truncated = true;
  const lines = end < 0 ? [] : text.slice(0, end).split("\n");
  if (lines.length > MAX_LINES) result.truncated = true;
  for (const raw of lines.slice(-MAX_LINES)) {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    result.linesScanned++;
    let matched = false;
    for (const [category, pattern] of Object.entries(categories)) {
      if (pattern.test(line)) {
        result.categories[category as keyof typeof categories]++;
        matched = true;
      }
    }
    if (!matched) result.categories.unclassified++;
  }
  return result;
}

/** Fixed private guest-memory file only. No caller-controlled path, tail size,
 * log text or file error is exposed through the owner API. */
export function kbsDiagnostics() {
  let file: number | undefined, bytes: Buffer | undefined;
  let result = empty();
  try {
    if (Number(statfsSync("/run/kbs-diagnostics").type) !== 0x01021994) throw new Error();
    // NONBLOCK prevents a replaced FIFO from blocking before its type check.
    file = openSync(LOG, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 ||
        info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE_BYTES) {
      throw new Error();
    }
    const start = Math.max(0, info.size - MAX_BYTES);
    bytes = Buffer.alloc(Math.min(info.size, MAX_BYTES));
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(file, bytes, read, bytes.length - read, start + read);
      if (count === 0) throw new Error();
      read += count;
    }
    result = classify(bytes, start > 0);
  } catch { /* Missing, replaced or malformed diagnostics remain unavailable. */ }
  finally {
    bytes?.fill(0);
    if (file !== undefined) closeSync(file);
  }
  return { version: 1, kbs: result };
}
