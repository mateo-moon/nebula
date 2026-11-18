import { createHash, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { readPreparedClient } from "./prepare";
import { startRuntime, type RuntimeOptions } from "./runtime";
import { createOwnerToken, ownerKey } from "./owner-token";
import { claimSha256, accessTokenBytes } from "./claim";

export const INSTANCE_SERVER_NAME = "nebula-instance";
const FILE = "instance.json";

export interface InstanceEnrollment {
  readonly version: 1;
  readonly approvalSha256: string;
  readonly audience: string;
  readonly certificate: string;
  readonly publicKeySha256: string;
}

function fingerprint(certificate: X509Certificate): string {
  return createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

function certificate(pem: string, allowExpired = false): X509Certificate {
  const cert = new X509Certificate(pem);
  if (cert.publicKey.asymmetricKeyType !== "ec" ||
      cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !cert.verify(cert.publicKey) || !cert.checkHost(INSTANCE_SERVER_NAME) ||
      Date.parse(cert.validFrom) > Date.now() || (!allowExpired && Date.parse(cert.validTo) <= Date.now())) {
    throw new Error("Invalid instance certificate");
  }
  return cert;
}

function approval(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Local owner state, never Kubernetes metadata or an operator's status claim. */
export function readEnrollment(directory: string, audience: string): InstanceEnrollment {
  const { profile } = readPreparedClient(directory);
  const path = join(directory, FILE);
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384) {
    throw new Error("Instance enrollment must be a private regular file");
  }
  const enrolled = JSON.parse(readFileSync(path, "utf8")) as InstanceEnrollment;
  if (enrolled.version !== 1 || enrolled.approvalSha256 !== approval(profile.identity) ||
      enrolled.audience !== audience || fingerprint(certificate(enrolled.certificate, true)) !== enrolled.publicKeySha256) {
    throw new Error("Instance enrollment differs from the approved client profile or audience");
  }
  return enrolled;
}

/** An expired certificate is still a saved public-key identity, never authority
 * to adopt another key. Refresh only through newly verified outer attestation,
 * without an owner JWT, then require the exact enrolled SPKI and a valid cert. */
export async function refreshEnrollment(directory: string, audience: string,
  runtime: Awaited<ReturnType<typeof startRuntime>>, signal?: AbortSignal): Promise<InstanceEnrollment> {
  const enrolled = readEnrollment(directory, audience);
  const pem = await discoverCertificate(runtime, signal);
  if (fingerprint(certificate(pem)) !== enrolled.publicKeySha256) {
    throw new Error("The endpoint is a different confidential instance; enrollment was preserved");
  }
  if (pem === enrolled.certificate) return enrolled;
  const next = { ...enrolled, certificate: pem }, path = join(directory, FILE), temporary = `${path}.${randomUUID()}.tmp`;
  // Avoid overwriting an out-of-band enrollment change during the round trip.
  const current = readEnrollment(directory, audience);
  if (JSON.stringify(current) !== JSON.stringify(enrolled)) {
    if (current.approvalSha256 !== enrolled.approvalSha256 || current.audience !== enrolled.audience || current.publicKeySha256 !== enrolled.publicKeySha256) {
      throw new Error("Enrollment changed during certificate refresh");
    }
    // Another request may have refreshed the same instance while this public
    // discovery was in flight. Keep its valid certificate instead of rolling
    // the cache back to an older response or failing an unrelated caller.
    if (Date.parse(new X509Certificate(current.certificate).validTo) > Date.now()) return current;
  }
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return next;
}

function consumeBounded(response: IncomingMessage): Promise<void> {
  return new Promise((accept, reject) => {
    let bytes = 0;
    const failed = () => reject(new Error("Instance response was interrupted or exceeded its limit"));
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) { failed(); response.destroy(); }
    });
    response.once("error", failed); response.once("aborted", failed);
    response.once("end", () => response.complete ? accept() : failed());
  });
}

async function discoverCertificate(runtime: Awaited<ReturnType<typeof startRuntime>>, signal?: AbortSignal): Promise<string> {
  runtime.assertAlive();
  return new Promise((accept, reject) => {
    const req = request({ socketPath: runtime.socketPath, path: "/nebula/v1/instance",
      agent: false, servername: INSTANCE_SERVER_NAME, minVersion: "TLSv1.3", rejectUnauthorized: false,
      signal: AbortSignal.any([runtime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) }, response => {
      const raw = (response.socket as TLSSocket).getPeerCertificate().raw;
      const pem = raw ? new X509Certificate(raw).toString() : undefined;
      void consumeBounded(response).then(() => {
        if (![200, 403].includes(response.statusCode ?? 0) || !pem) reject(new Error("Instance discovery failed"));
        else accept(pem);
      }, () => reject(new Error("Instance discovery failed")));
    });
    req.on("error", () => reject(new Error("Attested instance discovery failed")));
    req.end();
  });
}

/** Every request performs a pinned inner TLS handshake before sending a JWT or
 * resource. The outer TNG transport independently verifies CoCo attestation.
 * A check-then-POST against two independently routed HTTP connections is unsafe. */
export function instanceTls(enrolled: InstanceEnrollment) {
  return {
    ca: enrolled.certificate,
    servername: INSTANCE_SERVER_NAME,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3" as const,
    checkServerIdentity: (host: string, peer: Parameters<typeof checkServerIdentity>[1]) => {
      const error = checkServerIdentity(host, peer);
      if (error) return error;
      if (!peer.raw || fingerprint(new X509Certificate(peer.raw)) !== enrolled.publicKeySha256) {
        return new Error("The endpoint is a different confidential instance");
      }
      return undefined;
    },
  };
}

export interface EnrollOptions extends RuntimeOptions {
  readonly ownerPrivateKey: Parameters<typeof ownerKey>[0];
  readonly audience: string;
  readonly claimTokenFile?: string;
  readonly accessToken?: string;
}

/** Explicit first enrollment. Existing enrollment is never overwritten. No
 * credentials are sent on the discovery connection; only the outer attestation
 * is trusted there. Owner authorization is checked on a second, pinned channel. */
export async function enrollInstance(options: EnrollOptions): Promise<InstanceEnrollment> {
  const { directory, profile } = readPreparedClient(options.stateDirectory);
  if (!profile.instanceBound) throw new Error("Prepare this client with --instance-bound before enrollment");
  const path = join(directory, FILE);
  try { lstatSync(path); throw new Error("Instance already enrolled; prepare separate state for an explicitly authorized replacement"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const key = ownerKey(options.ownerPrivateKey);
  createOwnerToken(key, options.audience);
  let claimToken: Buffer | undefined;
  if (options.claimTokenFile || options.accessToken !== undefined) {
    const approvalPath = join(directory, "workload.json"), stat = lstatSync(approvalPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error("Invalid private workload approval");
    const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
    claimToken = accessTokenBytes(options);
    if (approval.audience !== options.audience || approval.ownerClaimSha256 !== claimSha256(claimToken)) {
      throw new Error("Claim token does not match the prepared workload approval");
    }
  }
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  try { runtime = await startRuntime(options); }
  catch (error) { claimToken?.fill(0); throw error; }
  try {
    const pem = await discoverCertificate(runtime);
    const enrolled: InstanceEnrollment = { version: 1, approvalSha256: approval(profile.identity),
      audience: options.audience, certificate: pem, publicKeySha256: fingerprint(certificate(pem)) };
    if (claimToken) {
      const body = Buffer.from(JSON.stringify({ token: claimToken.toString("hex"),
        ownerPublicKeyPem: createPublicKey(key).export({ type: "spki", format: "pem" }).toString() }));
      try {
        await new Promise<void>((accept, reject) => {
          runtime.assertAlive();
          const req = request({ socketPath: runtime.socketPath, path: "/nebula/v1/claim", method: "POST",
            agent: false, signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(30_000)]), ...instanceTls(enrolled),
            headers: { Authorization: `Bearer ${createOwnerToken(key, options.audience)}`,
              "Content-Type": "application/json", "Content-Length": body.length } }, response => {
            // A lost response after a successful claim is recoverable only if
            // the following owner-authorized round trip succeeds.
            void consumeBounded(response).then(() => {
              if (response.statusCode === 200 || response.statusCode === 409) accept();
              else reject(new Error("Instance claim was refused"));
            }, () => reject(new Error("Instance claim response was interrupted")));
          });
          req.on("error", () => reject(new Error("Instance claim failed or timed out")));
          req.end(body);
        });
      } finally { body.fill(0); claimToken.fill(0); }
    }
    await new Promise<void>((accept, reject) => {
      runtime.assertAlive();
      const req = request({ socketPath: runtime.socketPath, path: "/kbs/v0/resource-policy",
        agent: false, signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(30_000)]), ...instanceTls(enrolled),
        headers: { Authorization: `Bearer ${createOwnerToken(key, options.audience)}` },
      }, response => {
        void consumeBounded(response).then(() => {
          if (response.statusCode === 200) accept();
          else reject(new Error("Owner authorization failed for this instance"));
        }, () => reject(new Error("Instance authorization response was interrupted")));
      });
      req.on("error", () => reject(new Error("Instance changed or owner verification failed during enrollment")));
      req.end();
    });
    writeFileSync(path, JSON.stringify(enrolled, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return enrolled;
  } finally {
    claimToken?.fill(0);
    await runtime.close();
  }
}
