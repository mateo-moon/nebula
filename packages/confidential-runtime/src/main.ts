import { startGateway } from "./gateway.js";
import { awaitOwner, publishOwnerReady } from "./await-owner.js";
import { installGuestGuard } from "./guard.js";

process.umask(0o077);
if (process.argv[2] === "guard" && process.argv.length === 3) {
  installGuestGuard();
} else if (process.argv.length !== 4) throw new Error("Expected a measured runtime role and configuration");
else if (process.argv[2] === "gateway") {
  const config = JSON.parse(process.argv[3]);
  if (!Array.isArray(config.storageNames) || !Array.isArray(config.resources)) throw new Error("Expected measured storage and resource names");
  startGateway("/run/instance", config.storageNames, config.resources, config.ownerClaimSha256, config.audience, config.browser === true);
} else if (process.argv[2] === "await-owner") {
  const config = JSON.parse(process.argv[3]);
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  process.on("SIGINT", () => stop.abort());
  await awaitOwner(config, stop.signal);
  publishOwnerReady();
} else throw new Error("Unknown measured runtime role");
