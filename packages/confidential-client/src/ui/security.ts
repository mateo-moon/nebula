import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readPreparedClient, releaseStateDirectory, VERIFIER_IMAGE } from "../prepare";
import { readEnrollment } from "../enrollment";

/** Called only after a successful native, pinned and owner-authorized round
 * trip. Expected constraints are labelled as such; no raw quote is invented. */
export function verificationReceipt(release: string, tng: string) {
  const state = releaseStateDirectory(release), { profile } = readPreparedClient(state);
  const pin = JSON.parse(readFileSync(join(state, "instance.json"), "utf8"));
  const enrollment = readEnrollment(state, pin.audience), cert = new X509Certificate(enrollment.certificate);
  const privateKey = readFileSync(join(release, "owner.key"));
  let ownerPublicKeySha256: string;
  try { ownerPublicKeySha256 = createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex"); }
  finally { privateKey.fill(0); }
  const receipt = existsSync(join(release, "receipt.json")) ? JSON.parse(readFileSync(join(release, "receipt.json"), "utf8")) : undefined;
  return { version: 1, verifiedAt: new Date().toISOString(), source: "owner-local-native-verifier",
    expectedConstraints: profile.identity,
    checks: ["AMD certificate chain and SNP signature", "Approved guest launch measurement", "Independently generated native workload policy",
      "Fresh attestation challenge and TNG channel binding", "Enrolled guest TLS key", "Owner signature and authorization"],
    instance: { publicKeySha256: enrollment.publicKeySha256, certificateSha256: cert.fingerprint256,
      validFrom: cert.validFrom, validTo: cert.validTo, ownerPublicKeySha256 },
    image: receipt ? { reference: `${receipt.destination.split(":").slice(0, -1).join(":")}@${receipt.digest}`, digest: receipt.digest } : undefined,
    verifier: { image: VERIFIER_IMAGE, tngSha256: createHash("sha256").update(readFileSync(tng)).digest("hex"),
      policySha256: createHash("sha256").update(readFileSync(join(state, "storage/attestation_service_policy/approved_cpu.rego"))).digest("hex") },
    custody: { ownerPrivateKey: "local computer", imageAndDiskKeys: "local computer and enrolled guest only", externalBootstrapTrustee: false },
    evidence: "Native TNG and Trustee AS verified the attestation against these constraints. This receipt is a local verification record; it is not a raw hardware quote.",
    limits: ["Cluster-reported status is operational metadata, not attestation evidence.", "An administrator can deny service, including claiming an unused link first.",
      "Enrollment pins one instance; it does not enforce a global singleton or prevent encrypted-disk rollback."] };
}
