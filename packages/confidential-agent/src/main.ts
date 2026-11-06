import { agentStartupStage, startAgent } from "./agent.js";
import { AgentLifecycle } from "./lifecycle.js";
import { appendFileSync } from "node:fs";

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
  try { appendFileSync("/dev/termination-log", `nebula-agent:${agentStartupStage}\n`); }
  catch { /* A missing Kubernetes termination file cannot change fail-closed behavior. */ }
  process.stderr.write(`nebula-agent:${agentStartupStage}\n`);
  process.exit(1);
}
