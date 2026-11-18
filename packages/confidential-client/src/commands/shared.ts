import { lstatSync, readFileSync } from "node:fs";
import { resourcePath, type TrusteeResourcePath } from "nebula-cdk8s/trustee/policies";
import { TrusteeClient } from "../client";

export interface ConnectionOptions {
  state: string;
  tng: string;
  ownerKey: string;
  audience: string;
}

export function readOwnerKey(file: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("Owner key must be a private regular file (mode 0600)");
  }
  return readFileSync(file);
}

export function pathTuple(text: string): TrusteeResourcePath {
  const path = text.split("/");
  resourcePath(path);
  return path as [string, string, string];
}

export async function withClient(options: ConnectionOptions, operation: (client: TrusteeClient) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let client: TrusteeClient | undefined;
  let key: Buffer | undefined;
  try {
    key = readOwnerKey(options.ownerKey);
    client = await TrusteeClient.connect({
      stateDirectory: options.state,
      tngBinary: options.tng,
      ownerPrivateKey: key,
      audience: options.audience,
      signal: controller.signal,
    });
    await operation(client);
  } finally {
    try {
      await client?.close();
    } finally {
      key?.fill(0);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}
