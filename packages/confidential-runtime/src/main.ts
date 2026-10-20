import { startGateway } from "./gateway.js";

process.umask(0o077);
if (![3, 4].includes(process.argv.length) || process.argv[2] !== "gateway") {
  throw new Error("Expected the gateway role");
}
const storageNames = JSON.parse(process.argv[3] ?? "[]");
if (!Array.isArray(storageNames)) throw new Error("Expected measured storage names");
startGateway("/run/instance", storageNames);
