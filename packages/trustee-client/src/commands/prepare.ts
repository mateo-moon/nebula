import { readFileSync } from "node:fs";
import { prepareClient } from "../prepare";

export interface PrepareOptions {
  identity: string;
  host: string;
  port: number;
  state: string;
  localPort: number;
  verifierPort: number;
  vcek?: string;
}

export function prepare(options: PrepareOptions): void {
  const { host } = options;
  prepareClient({
    stateDirectory: options.state,
    identity: JSON.parse(readFileSync(options.identity, "utf8")),
    target: { host, port: options.port },
    localPort: options.localPort,
    verifierPort: options.verifierPort,
    vcekFile: options.vcek,
  });
  console.log("Prepared local verifier state.");
}
