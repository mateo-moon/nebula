import { startGateway } from "./gateway.js";
import { awaitOwner } from "./await-owner.js";

process.umask(0o077);
if (process.argv.length !== 4) throw new Error("Expected a measured runtime role and configuration");
const config = JSON.parse(process.argv[3]);
if (process.argv[2] === "gateway") {
  if (!Array.isArray(config)) throw new Error("Expected measured storage names");
  startGateway("/run/instance", config);
} else if (process.argv[2] === "await-owner") {
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  process.on("SIGINT", () => stop.abort());
  await awaitOwner(config, stop.signal);
} else throw new Error("Unknown measured runtime role");
