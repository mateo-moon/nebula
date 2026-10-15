import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRUSTEE_DENIED_AGENT_REQUESTS, trusteeInitData, trusteePlan,
  type TrusteeConfig, type TrusteeSnpIdentity } from "../../src/modules/k8s/trustee";

let certificate: string | undefined;
export function testCertificate(): string {
  if (certificate) return certificate;
  const dir = mkdtempSync(join(tmpdir(), "nebula-trustee-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=bootstrap.example.test", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    return certificate = readFileSync(join(dir, "cert.pem"), "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const identity = (index = 1): TrusteeSnpIdentity => ({
  measurement: String(index).repeat(96), initDataSha256: String(index + 1).repeat(64),
  chipId: String(index + 2).repeat(128),
  minimumReportedTcb: { bootloader: 3, tee: 1, snp: 12, microcode: 72 },
});

export function trusteeConfig(): TrusteeConfig {
  return { name: "trustee", namespace: "confidential-keys",
    image: `registry.example.test/trustee@sha256:${"a".repeat(64)}`,
    bootstrap: { url: "https://bootstrap.example.test:8443", certificatePem: testCertificate(),
      tlsPrivateKey: ["owner", "trustee-tls", "key-v1"], tlsCertificate: ["owner", "trustee-tls", "cert-v1"] },
    resources: [{ path: ["default", "image-key", "release-1"], bootstrapPath: ["owner", "image-key", "release-1"], recipients: [identity()] }],
    nodeSelector: { "confidential-computing": "snp" },
    clients: [{ namespace: "workloads", podLabels: { app: "confidential-worker" } }],
  };
}

// This intentionally denies ALL container creation. It is a synthetic source
// gate/hash fixture, not a deployable genpolicy artifact or hardware evidence.
export const denyPolicy = `package agent_policy
default CreateContainerRequest := false
default CopyFileRequest := false
${TRUSTEE_DENIED_AGENT_REQUESTS.map(request => `default ${request} := false`).join("\n")}
`;

export function testArtifact(config = trusteeConfig()) {
  return trusteeInitData(config, { canonicalPodSha256: trusteePlan(config).canonicalPodSha256, policyRego: denyPolicy });
}

export const evidence = (guest = identity()): any => ({
  init_data: guest.initDataSha256,
  snp: { measurement: guest.measurement, chip_id: guest.chipId, policy_debug_allowed: false, policy_migrate_ma: false,
    ...Object.fromEntries(Object.entries(guest.minimumReportedTcb).map(([key, value]) => [`reported_tcb_${key}`, value])) },
});
