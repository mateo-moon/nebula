import { readFileSync } from "node:fs";
import { pathTuple, withClient, type ConnectionOptions } from "./shared";

export interface AttestationPolicyOptions extends ConnectionOptions {
  policyId: string;
}

export async function verify(options: ConnectionOptions): Promise<void> {
  await withClient(options, async () => {
    console.log("Attested Trustee connection and owner authorization verified.");
  });
}

export async function listResourcePolicies(options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => {
    console.log(JSON.stringify(await client.listResourcePolicies()));
  });
}

export async function putResource(path: string, file: string, options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => {
    await client.putResource(pathTuple(path), readFileSync(file));
    console.log("Resource provisioned.");
  });
}

export async function deleteResource(path: string, options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => {
    await client.deleteResource(pathTuple(path));
    console.log("Resource deleted.");
  });
}

export async function setResourcePolicy(file: string, options: ConnectionOptions): Promise<void> {
  await withClient(options, async client => {
    await client.setResourcePolicy(readFileSync(file, "utf8"));
    console.log("Resource policy installed.");
  });
}

export async function setAttestationPolicy(file: string, options: AttestationPolicyOptions): Promise<void> {
  await withClient(options, async client => {
    await client.setAttestationPolicy(readFileSync(file, "utf8"), options.policyId);
    console.log("Attestation policy installed.");
  });
}
