import { startAgent } from "./agent.js";
import { AgentLifecycle } from "./lifecycle.js";

try {
  if (process.argv.length !== 3) throw new Error("Expected one measured agent configuration");
  const agent = new AgentLifecycle();
  const stop = () => { void agent.close(); };
  const fail = () => { void agent.close(new Error("Agent module failed")); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
  await startAgent(process.argv[2], agent);
  const error = await agent.closed;
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.off("uncaughtException", fail);
  process.off("unhandledRejection", fail);
  if (error) throw error;
  process.exit(0);
} catch {
  // Never print measured arguments, request bodies or native key diagnostics.
  process.stderr.write("Confidential agent stopped before completing its modules\n");
  process.exit(1);
}
