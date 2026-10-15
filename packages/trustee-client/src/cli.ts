import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { TrusteeClient, type TrusteeClientOptions } from "./client.js";
import { prepareClient } from "./prepare.js";
import { createOwnerToken } from "./owner-token.js";
import { resourcePath, type TrusteeResourcePath } from "../../nebula/src/modules/k8s/trustee/policies.js";

const program = new Command().name("nebula-trustee").version("0.1.0")
  .description("Verify and provision a Nebula Trustee through native TNG attested TLS");
const privateKey = (file: string) => {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Owner key must be a private regular file (mode 0600)");
  return readFileSync(file);
};
const pathTuple = (text: string): TrusteeResourcePath => {
  const path = text.split("/"); resourcePath(path); return path as unknown as TrusteeResourcePath;
};

program.command("prepare").description("Create fresh private local verifier state, offline")
  .requiredOption("--identity <file>", "Independently approved SNP identity JSON")
  .requiredOption("--host <host>", "Attested Trustee endpoint (L4 pass-through)")
  .option("--port <number>", "Remote TLS port", Number, 8443)
  .requiredOption("--state <directory>", "New state directory; refuses an existing directory")
  .option("--local-port <number>", "Local TNG port", Number, 18080)
  .option("--verifier-port <number>", "Local AS port", Number, 18082)
  .option("--vcek <file>", "Public VCEK certificate for offline verification")
  .action(options => {
    const { host } = options;
    prepareClient({ stateDirectory: options.state, identity: JSON.parse(readFileSync(options.identity, "utf8")),
      target: { host, port: options.port }, localPort: options.localPort,
      verifierPort: options.verifierPort, vcekFile: options.vcek });
    console.log("Prepared local verifier state.");
  });

program.command("owner-header <new-file>").description("Write a private five-minute native admin header for manual use")
  .requiredOption("--owner-key <file>", "Private P-256 owner key")
  .requiredOption("--audience <name>", "Trustee deployment name")
  .action((file, options) => {
    const key = privateKey(options.ownerKey);
    try { writeFileSync(file, `Authorization: Bearer ${createOwnerToken(key, options.audience)}\n`, { mode: 0o600, flag: "wx" }); }
    finally { key.fill(0); }
  });

interface ConnectionOptions {
  state: string; tng: string; ownerKey: string; audience: string;
}
function connected(command: Command): Command {
  return command.requiredOption("--state <directory>", "Prepared local verifier state")
    .requiredOption("--tng <file>", "Absolute path to the qualified TNG client")
    .requiredOption("--owner-key <file>", "Private P-256 owner key (never mounted into Docker)")
    .requiredOption("--audience <name>", "Trustee deployment name");
}
async function withClient(options: ConnectionOptions, operation: (client: TrusteeClient) => Promise<void>) {
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let client: TrusteeClient | undefined, key: Buffer | undefined;
  try {
    key = privateKey(options.ownerKey);
    const config: TrusteeClientOptions = { stateDirectory: options.state, tngBinary: options.tng,
      ownerPrivateKey: key, audience: options.audience, signal: controller.signal };
    client = await TrusteeClient.connect(config);
    await operation(client);
  } finally {
    try { await client?.close(); }
    finally { key?.fill(0); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
  }
}

connected(program.command("verify").description("Verify attested TLS and owner authorization with a native KBS request"))
  .action(options => withClient(options, async () => { console.log("Attested Trustee connection and owner authorization verified."); }));
connected(program.command("list-resource-policies").description("List installed resource policy IDs"))
  .action(options => withClient(options, async client => { console.log(JSON.stringify(await client.listResourcePolicies())); }));
connected(program.command("put-resource <path> <file>").description("Provision bytes at repository/type/tag"))
  .action((path, file, options) => withClient(options, async client => {
    await client.putResource(pathTuple(path), readFileSync(file)); console.log("Resource provisioned.");
  }));
connected(program.command("delete-resource <path>").description("Delete the resource at repository/type/tag"))
  .action((path, options) => withClient(options, async client => { await client.deleteResource(pathTuple(path)); console.log("Resource deleted."); }));
connected(program.command("set-resource-policy <file>").description("Install reviewed resource-release Rego"))
  .action((file, options) => withClient(options, async client => { await client.setResourcePolicy(readFileSync(file, "utf8")); console.log("Resource policy installed."); }));
connected(program.command("set-attestation-policy <file>").description("Install reviewed attestation-appraisal Rego"))
  .option("--policy-id <id>", "Native AS policy storage ID", "default_cpu")
  .action((file, options) => withClient(options, async client => {
    await client.setAttestationPolicy(readFileSync(file, "utf8"), options.policyId); console.log("Attestation policy installed.");
  }));

try { await program.parseAsync(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Trustee client failed");
  process.exitCode ||= 1;
}
