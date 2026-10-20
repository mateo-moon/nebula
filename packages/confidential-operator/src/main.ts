import { main } from "./render";

main().catch(() => {
  // Native registry errors can include credentials; never log their output.
  process.stderr.write("Confidential declaration validation or rendering failed\n");
  process.exitCode = 1;
});
