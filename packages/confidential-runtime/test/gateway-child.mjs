import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { startGateway } from "../dist/gateway.js";

process.umask(0o077);
startGateway(process.argv[2]);
const cert = new X509Certificate(readFileSync(`${process.argv[2]}/identity/cert.pem`));
process.send?.(cert.fingerprint256);
