import { mkdirSync, writeFileSync } from "node:fs";
import { confidentialCrds } from "nebula-cdk8s/confidential-workloads";

mkdirSync("config/crd/bases", { recursive: true });
for (const crd of confidentialCrds()) {
  writeFileSync(`config/crd/bases/${crd.metadata.name}.json`, JSON.stringify(crd, null, 2) + "\n");
}
