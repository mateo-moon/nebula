import { enrollInstance } from "../enrollment";
import { readOwnerKey, type ConnectionOptions } from "./shared";

export async function enroll(options: ConnectionOptions): Promise<void> {
  const key = readOwnerKey(options.ownerKey);
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const instance = await enrollInstance({ stateDirectory: options.state, tngBinary: options.tng,
      ownerPrivateKey: key, audience: options.audience, signal: controller.signal });
    console.log(`Enrolled confidential instance ${instance.publicKeySha256}.`);
  } finally {
    key.fill(0);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
