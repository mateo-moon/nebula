import { main } from "./render";
import { ConfidentialValidationError } from "nebula-cdk8s/confidential-workloads";

main().catch(error => {
  if (error instanceof ConfidentialValidationError) {
    process.stdout.write(JSON.stringify({ error: { reason: "InvalidDeclaration", message: error.message } }));
    return;
  }
  // Native registry errors can include credentials; never log their output.
  process.stderr.write("Confidential declaration validation or rendering failed\n");
  process.exitCode = 1;
});
