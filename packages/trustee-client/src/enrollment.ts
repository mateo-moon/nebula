import { createHash, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { readPreparedClient } from "./prepare";
import { startRuntime, type RuntimeOptions } from "./runtime";
import { createOwnerToken, ownerKey } from "./owner-token";

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

function certificate(pem: string): X509Certificate {
  const cert = new X509Certificate(pem);
  if (cert.publicKey.asymmetricKeyType !== "ec" ||
      cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !cert.verify(cert.publicKey) || !cert.checkHost(INSTANCE_SERVER_NAME) ||
      Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) {
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
      enrolled.audience !== audience || fingerprint(certificate(enrolled.certificate)) !== enrolled.publicKeySha256) {
    throw new Error("Instance enrollment differs from the approved client profile or audience");
  }
  return enrolled;
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
  const runtime = await startRuntime(options);
  try {
    const pem = await new Promise<string>((accept, reject) => {
      runtime.assertAlive();
      const req = request({ host: "127.0.0.1", port: runtime.port, path: "/nebula/v1/instance",
        agent: false, servername: INSTANCE_SERVER_NAME, minVersion: "TLSv1.3",
        // This one public discovery request runs only inside verified TNG.
        rejectUnauthorized: false, signal: runtime.signal,
      }, response => {
        const raw = (response.socket as TLSSocket).getPeerCertificate().raw;
        response.resume();
        if (response.statusCode !== 200 || !raw) reject(new Error("Instance discovery failed"));
        else accept(new X509Certificate(raw).toString());
      });
      req.setTimeout(30_000, () => req.destroy());
      req.on("error", () => reject(new Error("Attested instance discovery failed")));
      req.end();
    });
    const enrolled: InstanceEnrollment = { version: 1, approvalSha256: approval(profile.identity),
      audience: options.audience, certificate: pem, publicKeySha256: fingerprint(certificate(pem)) };
    await new Promise<void>((accept, reject) => {
      runtime.assertAlive();
      const req = request({ host: "127.0.0.1", port: runtime.port, path: "/kbs/v0/resource-policy",
        agent: false, signal: runtime.signal, ...instanceTls(enrolled),
        headers: { Authorization: `Bearer ${createOwnerToken(key, options.audience)}` },
      }, response => {
        response.resume();
        if (response.statusCode === 200) accept();
        else reject(new Error("Owner authorization failed for this instance"));
      });
      req.setTimeout(30_000, () => req.destroy());
      req.on("error", () => reject(new Error("Instance changed or owner verification failed during enrollment")));
      req.end();
    });
    writeFileSync(path, JSON.stringify(enrolled, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return enrolled;
  } finally {
    await runtime.close();
  }
}
