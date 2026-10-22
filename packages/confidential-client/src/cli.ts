#!/usr/bin/env node
import { Command } from "commander";
import { enroll } from "./commands/enroll";
import { createInvitation, createOwnerKey, deploy } from "./deploy";
import { publishImage } from "./publisher";
import { readPreparedClient } from "./prepare";
import { readEnrollment } from "./enrollment";
import { withClient, pathTuple } from "./commands/shared";
import { renewClient } from "./prepare";
import { prepareWorkloadCommand, configureWorkload, storageStatus, bootstrapStatus } from "./commands/workload";
import {
  prepare, ownerHeader, verify, listResourcePolicies, putResource, deleteResource,
  setResourcePolicy, setAttestationPolicy,
} from "./commands";

const program = new Command()
  .name("confidential-client")
  .version("0.1.0")
  .description("Publish encrypted workloads and manage an attested Nebula Confidential stack");

program.command("invite <file>")
  .description("Administrator: create a private one-use claim token and print its public SHA-256 commitment")
  .action((file: string) => { console.log(createInvitation(file)); });

program.command("owner-key <file>")
  .description("Create or validate a private P-256 workload owner key")
  .action((file: string) => { createOwnerKey(file); console.log(`Owner key is stored in ${file}`); });

program.command("deploy <manifest>")
  .description("Encrypt and publish a local image, attest and claim the guest, then provision its keys")
  .requiredOption("--name <name>", "ConfidentialWorkload name in the reviewed declaration")
  .requiredOption("--host <host>", "Owner endpoint provided by DevOps (L4 pass-through)")
  .option("--port <number>", "Owner endpoint port", Number, 8443)
  .requiredOption("--source-image <image>", "Local linux/amd64 OCI image")
  .requiredOption("--release-dir <directory>", "Private output directory for owner and image keys")
  .requiredOption("--claim-token <file>", "Private one-use claim token provided by DevOps (0600)")
  .requiredOption("--tng <file>", "Qualified native TNG client executable")
  .option("--vcek <file>", "Public AMD VCEK certificate for native offline verification")
  .option("--registry-auth-file <file>", "Private skopeo auth JSON; ECR uses local AWS credentials by default")
  .option("--aws-profile <name>", "AWS profile for ECR publication")
  .option("--helper-image <digest>", "Reviewed CoCo encryption helper image, pinned by digest")
  .option("--genpolicy <file>", "Qualified native genpolicy executable")
  .option("--cache <directory>", "Public image metadata cache")
  .option("--local-port <number>", "Local TNG port (default 18080 for fresh state)", Number)
  .option("--verifier-port <number>", "Local attestation verifier port (default 18082 for fresh state)", Number)
  .option("--volume-key <binding=file>", "Existing private 32-byte volume key; repeat per binding", (value, values: string[]) => [...values, value], [])
  .option("--resource-file <path=file>", "Private application resource; repeat for every extra declared path", (value, values: string[]) => [...values, value], [])
  .option("--wait-seconds <number>", "Maximum time for publication, attestation and bootstrap", Number, 900)
  .action(async (manifest: string, options: any) => {
    const { host } = options;
    const result = await deploy({ manifest, name: options.name, host, port: options.port,
      sourceImage: options.sourceImage, releaseDirectory: options.releaseDir, claimTokenFile: options.claimToken,
      tngBinary: options.tng, registryAuthFile: options.registryAuthFile, awsProfile: options.awsProfile,
      helperImage: options.helperImage, genpolicy: options.genpolicy, cache: options.cache,
      vcekFile: options.vcek,
      localPort: options.localPort, verifierPort: options.verifierPort,
      volumeKey: options.volumeKey, resourceFile: options.resourceFile, waitSeconds: options.waitSeconds });
    console.log(JSON.stringify(result, null, 2));
  });

program.command("encrypt-publish")
  .description("Encrypt every layer of a local image and publish it without provisioning a key")
  .requiredOption("--source-image <image>", "Local linux/amd64 OCI image")
  .requiredOption("--destination <tag>", "Reserved full registry/repository:tag")
  .requiredOption("--resource <path>", "Trustee image key path repository/type/tag")
  .requiredOption("--release-dir <directory>", "Private release directory")
  .option("--registry-auth-file <file>", "Private skopeo auth JSON")
  .option("--aws-profile <name>", "AWS profile for ECR publication")
  .option("--helper-image <digest>", "Reviewed CoCo encryption helper image")
  .action((options: any) => {
    console.log(JSON.stringify(publishImage({ sourceImage: options.sourceImage, destination: options.destination,
      imageKeyResource: pathTuple(options.resource), releaseDirectory: options.releaseDir,
      registryAuthFile: options.registryAuthFile, awsProfile: options.awsProfile, helperImage: options.helperImage }), null, 2));
  });

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
  .option("--claim-token <file>", "Private one-use Trustee claim token (0600)")
  .action(prepareWorkloadCommand);

program.command("owner-header <new-file>")
  .description("Write a private five-minute native admin header for manual use")
  .requiredOption("--owner-key <file>", "Private P-256 owner key")
  .requiredOption("--audience <name>", "Trustee deployment name")
  .action(ownerHeader);

program.command("renew <new-state>")
  .description("Renew local verifier credentials offline, preserving the enrolled instance and workload approval")
  .requiredOption("--state <directory>", "Existing private verifier state")
  .option("--vcek <file>", "Public AMD VCEK certificate to use for native offline verification")
  .action(async (destination: string, options: { state: string; vcek?: string }) => {
    await renewClient(options.state, destination, { vcekFile: options.vcek });
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
connected(program.command("attest").description("Verify the approved SNP identity and enrolled instance, then print the trusted identity"))
  .action(async (options: any) => {
    const approved = readPreparedClient(options.state);
    const enrolled = readEnrollment(options.state, options.audience);
    await withClient(options, async () => {
      console.log(JSON.stringify({ verified: true, snp: approved.profile.identity,
        instancePublicKeySha256: enrolled.publicKeySha256, audience: enrolled.audience }, null, 2));
    });
  });
connected(program.command("status").description("Read owner-authorized bootstrap and storage status"))
  .action(async (options: any) => withClient(options, async client => {
    console.log(JSON.stringify({ bootstrap: await client.bootstrapStatus(), storage: await client.storageStatus() }, null, 2));
  }));
connected(program.command("enroll").description("Claim and enroll one attested instance; refuses existing enrollment"))
  .option("--claim-token <file>", "Private one-use Trustee claim token (0600)")
  .action(enroll);
connected(program.command("configure-workload").description("Install the independently prepared local release policy on the enrolled instance"))
  .action(configureWorkload);
connected(program.command("storage-status").description("Read non-secret storage phase through the enrolled attested connection"))
  .action(storageStatus);
connected(program.command("bootstrap-status").description("Read owner-authorized guest-local retrieval diagnostics; never returns resource bytes"))
  .action(bootstrapStatus);
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
  console.error(error instanceof Error ? error.message : "Confidential client failed");
  process.exitCode ||= 1;
});
