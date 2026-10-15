import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { tngTrusteeClientPlan } from "nebula-cdk8s/trustee/client-plan";
import { snpIdentity, type TrusteeSnpIdentity } from "nebula-cdk8s/trustee/policies";

export const VERIFIER_IMAGE = "ghcr.io/confidential-containers/staged-images/coco-as-restful@sha256:997d6ba65bbfd6464ebbecaa99ca04ec8050304c9c976cd44e65971c7427eb7d";

export interface PrepareClientOptions {
  readonly stateDirectory: string;
  readonly identity: TrusteeSnpIdentity;
  readonly target: { readonly host: string; readonly port: number };
  readonly localPort?: number;
  readonly verifierPort?: number;
  readonly opensslBinary?: string;
  /** Optional public AMD endorsement certificate; AS still verifies the chain. */
  readonly vcekFile?: string;
}

interface Profile {
  version: 1;
  identity: TrusteeSnpIdentity;
  target: { host: string; port: number };
  localPort: number;
  verifierPort: number;
  offlineVcek: boolean;
}

const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const policyFile = (directory: string) => join(directory, "storage", "attestation_service_policy", "approved_cpu.rego");
function planFor(directory: string, profile: Profile) {
  const plan = tngTrusteeClientPlan(profile.identity, profile.target, profile.localPort, profile.verifierPort, join(directory, "ca.pem"));
  return { ...plan, asConfig: { ...plan.asConfig, ...(profile.offlineVcek ? {
    verifier_config: { snp_verifier: { vcek_sources: [{ type: "OfflineStore", path: "/state/kds-store" }] } },
  } : {}) } };
}

/** Offline preparation. Refuses existing state and never writes the owner's key. */
export function prepareClient(options: PrepareClientOptions): string {
  const profile: Profile = { version: 1, identity: snpIdentity(options.identity), target: { ...options.target },
    localPort: options.localPort ?? 18080, verifierPort: options.verifierPort ?? 18082, offlineVcek: options.vcekFile !== undefined };
  const directory = resolve(options.stateDirectory);
  // Validate before creating state. Docker's --mount parser treats commas specially.
  if (directory.includes(",") || /[\x00-\x1f]/.test(directory)) throw new TypeError("Unsupported state directory name");
  planFor(directory, profile);
  const vcek = options.vcekFile ? readFileSync(options.vcekFile) : undefined;
  if (vcek) new X509Certificate(vcek);
  mkdirSync(directory, { mode: 0o700 }); // deliberately not recursive; EEXIST must fail
  const out = realpathSync(directory);
  const oldMask = process.umask(0o077);
  try {
    const plan = planFor(out, profile);
    mkdirSync(join(out, "storage", "attestation_service_policy"), { recursive: true, mode: 0o700 });
    const openssl = (...args: string[]) => {
      try { execFileSync(options.opensslBinary ?? "openssl", args, { cwd: out, stdio: "ignore", timeout: 15_000 }); }
      catch { throw new Error("OpenSSL could not create the local verifier signing chain"); }
    };
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
    openssl("req", "-new", "-x509", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=nebula-client-verifier-ca",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign", "-out", "ca.pem");
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "signer.key");
    openssl("req", "-new", "-key", "signer.key", "-subj", "/CN=nebula-client-verifier", "-out", "signer.csr");
    writeFileSync(join(out, "signer.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n", { mode: 0o600 });
    openssl("x509", "-req", "-in", "signer.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-sha256",
      "-days", "2", "-extfile", "signer.ext", "-out", "signer.pem");
    save(join(out, "as.json"), plan.asConfig);
    save(join(out, "tng.json"), plan.tngConfig);
    writeFileSync(policyFile(out), plan.policy, { mode: 0o600, flag: "wx" });
    if (vcek) {
      const store = join(out, "kds-store", "vcek", profile.identity.chipId);
      mkdirSync(store, { recursive: true, mode: 0o700 });
      writeFileSync(join(store, "vcek.der"), new X509Certificate(vcek).raw, { mode: 0o600, flag: "wx" });
    }
    for (const name of ["ca.key", "ca.srl", "signer.csr", "signer.ext"]) rmSync(join(out, name), { force: true });
    save(join(out, "client.json"), profile);
    return out;
  } catch (error) {
    rmSync(out, { recursive: true, force: true }); // only the fresh directory this call created
    throw error;
  } finally { process.umask(oldMask); }
}

/** Refuse relaxed policies, moved state and modified trust configuration. */
export function readPreparedClient(directory: string) {
  const out = realpathSync(directory);
  if (out.includes(",") || /[\x00-\x1f]/.test(out)) throw new TypeError("Unsupported state directory name");
  if ((lstatSync(out).mode & 0o077) !== 0) throw new Error("Client state must be private (mode 0700)");
  const read = (name: string) => {
    const file = join(out, name), stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Client state contains a non-private or non-regular file");
    return readFileSync(file);
  };
  const profile = JSON.parse(read("client.json").toString()) as Profile;
  if (profile.version !== 1 || typeof profile.offlineVcek !== "boolean" ||
      !Number.isInteger(profile.localPort) || !Number.isInteger(profile.verifierPort)) throw new Error("Unsupported client state");
  const plan = planFor(out, profile);
  if (!isDeepStrictEqual(JSON.parse(read("as.json").toString()), plan.asConfig) ||
      !isDeepStrictEqual(JSON.parse(read("tng.json").toString()), plan.tngConfig) ||
      read("storage/attestation_service_policy/approved_cpu.rego").toString() !== plan.policy) {
    throw new Error("Verifier configuration differs from the approved client profile; prepare fresh state");
  }
  const ca = new X509Certificate(read("ca.pem")), signer = new X509Certificate(read("signer.pem"));
  const key = createPublicKey(createPrivateKey(read("signer.key"))).export({ format: "der", type: "spki" });
  if (!ca.ca || signer.ca || !signer.verify(ca.publicKey) ||
      !isDeepStrictEqual(signer.keyUsage, ["1.3.6.1.5.5.7.3.2"]) ||
      !key.equals(signer.publicKey.export({ format: "der", type: "spki" })) ||
      [ca, signer].some(cert => Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now() + 60_000)) {
    throw new Error("Invalid or expired verifier signing chain; prepare fresh state");
  }
  if (profile.offlineVcek) read(`kds-store/vcek/${profile.identity.chipId}/vcek.der`);
  return { directory: out, profile };
}
