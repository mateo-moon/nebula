#!/usr/bin/env node
import { Command } from "commander";
import { enroll } from "./commands/enroll";
import { renewClient } from "./prepare";
import { prepareWorkloadCommand, configureWorkload, storageStatus } from "./commands/workload";
import {
  prepare, ownerHeader, verify, listResourcePolicies, putResource, deleteResource,
  setResourcePolicy, setAttestationPolicy,
} from "./commands";

const program = new Command()
  .name("nebula-trustee")
  .version("0.1.0")
  .description("Verify and provision a Nebula Trustee through native TNG attested TLS");

program.command("prepare")
  .description("Create fresh private local verifier state, offline")
  .requiredOption("--identity <file>", "Independently approved SNP identity JSON")
  .requiredOption("--host <host>", "Attested Trustee endpoint (L4 pass-through)")
  .option("--port <number>", "Remote TLS port", Number, 8443)
  .requiredOption("--state <directory>", "New state directory; refuses an existing directory")
  .option("--local-port <number>", "Local TNG port", Number, 18080)
  .option("--verifier-port <number>", "Local AS port", Number, 18082)
  .option("--vcek <file>", "Public VCEK certificate for offline verification")
  .option("--instance-bound", "Require enrollment and pinned instance TLS for all owner requests")
  .action(prepare);

program.command("prepare-workload <manifest>")
  .description("Independently synthesize reviewed ConfidentialWorkload and ConfidentialStorage declarations")
  .requiredOption("--name <name>", "ConfidentialWorkload name in the declaration")
  .requiredOption("--host <host>", "Selected instance endpoint through L4 pass-through")
  .option("--port <number>", "Remote TLS port", Number, 8443)
  .requiredOption("--state <directory>", "New private state directory")
  .option("--local-port <number>", "Local TNG port", Number, 18080)
  .option("--verifier-port <number>", "Local AS port", Number, 18082)
  .option("--vcek <file>", "Public VCEK certificate for offline verification")
  .option("--genpolicy <file>", "Qualified native genpolicy executable")
  .option("--cache <directory>", "Public image metadata cache")
  .action(prepareWorkloadCommand);

program.command("owner-header <new-file>")
  .description("Write a private five-minute native admin header for manual use")
  .requiredOption("--owner-key <file>", "Private P-256 owner key")
  .requiredOption("--audience <name>", "Trustee deployment name")
  .action(ownerHeader);

program.command("renew <new-state>")
  .description("Renew local verifier credentials offline, preserving the enrolled instance and workload approval")
  .requiredOption("--state <directory>", "Existing private verifier state")
  .action(async (destination: string, options: { state: string }) => {
    await renewClient(options.state, destination);
    console.log("Renewed local verifier credentials; the approved identity and instance pin are unchanged.");
  });

function connected(command: Command): Command {
  return command
    .requiredOption("--state <directory>", "Prepared local verifier state")
    .requiredOption("--tng <file>", "Absolute path to the qualified TNG client")
    .requiredOption("--owner-key <file>", "Private P-256 owner key (never mounted into Docker)")
    .requiredOption("--audience <name>", "Trustee deployment name");
}

connected(program.command("verify").description("Verify attested TLS and owner authorization with a native KBS request"))
  .action(verify);
connected(program.command("enroll").description("Enroll one attested instance; refuses existing enrollment"))
  .action(enroll);
connected(program.command("configure-workload").description("Install the independently prepared local release policy on the enrolled instance"))
  .action(configureWorkload);
connected(program.command("storage-status").description("Read non-secret storage phase through the enrolled attested connection"))
  .action(storageStatus);
connected(program.command("list-resource-policies").description("List installed resource policy IDs"))
  .action(listResourcePolicies);
connected(program.command("put-resource <path> <file>").description("Provision bytes at repository/type/tag"))
  .action(putResource);
connected(program.command("delete-resource <path>").description("Delete a resource at repository/type/tag"))
  .action(deleteResource);
connected(program.command("set-resource-policy <file>").description("Install reviewed resource-release Rego"))
  .action(setResourcePolicy);
connected(program.command("set-attestation-policy <file>").description("Install reviewed attestation-appraisal Rego"))
  .option("--policy-id <id>", "Native AS policy storage ID", "default_cpu")
  .action(setAttestationPolicy);

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Trustee client failed");
  process.exitCode ||= 1;
});
