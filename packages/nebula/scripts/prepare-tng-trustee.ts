/** Offline only: prepare measured public configuration or a CLIENT-LOCAL
 * verifier. Never creates cluster Secrets or contacts a bootstrap Trustee. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tngTrusteePlan, tngTrusteeInitData, tngTrusteeClientPlan, type TngTrusteeConfig,
  type TrusteeSnpIdentity } from "../src/modules/k8s/trustee";

const [mode, input, ...args] = process.argv.slice(2);
const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
if (mode === "template" && input && args.length === 1) {
  const plan = tngTrusteePlan(load<TngTrusteeConfig>(input));
  mkdirSync(args[0], { recursive: true, mode: 0o700 });
  save(join(args[0], "deployment.json"), plan.workload);
  save(join(args[0], "preparation.json"), { canonicalPodSha256: plan.canonicalPodSha256 });
} else if (mode === "bind" && input && args.length === 3) {
  const prepared = load<{ canonicalPodSha256: string }>(args[0]);
  save(args[2], tngTrusteeInitData(load<TngTrusteeConfig>(input), {
    canonicalPodSha256: prepared.canonicalPodSha256, policyRego: readFileSync(args[1], "utf8") }));
} else if (mode === "client" && input && args.length === 3) {
  const [host, port, directory] = args;
  const plan = tngTrusteeClientPlan(load<TrusteeSnpIdentity>(input), { host, port: Number(port) },
    18080, 18082, join(resolve(directory), "ca.pem"));
  // Refuse an existing directory: never silently rotate a running verifier's key.
  const out = resolve(directory); mkdirSync(out, { mode: 0o700 });
  mkdirSync(join(out, "storage", "attestation_service_policy"), { recursive: true, mode: 0o700 });
  const openssl = (...argv: string[]) => execFileSync("openssl", argv, { cwd: out, stdio: ["ignore", "ignore", "pipe"] });
  const oldMask = process.umask(0o077);
  try {
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
    openssl("req", "-new", "-x509", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=nebula-client-verifier-ca",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign", "-out", "ca.pem");
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "signer.key");
    openssl("req", "-new", "-key", "signer.key", "-subj", "/CN=nebula-client-verifier", "-out", "signer.csr");
    writeFileSync(join(out, "signer.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
    openssl("x509", "-req", "-in", "signer.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-sha256",
      "-days", "2", "-extfile", "signer.ext", "-out", "signer.pem");
    save(join(out, "as.json"), plan.asConfig);
    save(join(out, "tng.json"), plan.tngConfig);
    writeFileSync(join(out, "storage", "attestation_service_policy", "approved_cpu.rego"), plan.policy);
  } finally {
    for (const name of ["ca.key", "ca.srl", "signer.csr", "signer.ext"]) rmSync(join(out, name), { force: true });
    process.umask(oldMask);
  }
} else {
  throw new Error("Usage: prepare-tng-trustee.ts template PUBLIC_CONFIG OUTDIR | bind PUBLIC_CONFIG PREPARATION REVIEWED_REGO ARTIFACT | client EXPECTED_SNP_IDENTITY TARGET_HOST TARGET_PORT NEW_OUTDIR");
}
