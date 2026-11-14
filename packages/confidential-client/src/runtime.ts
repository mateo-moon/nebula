import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { readPreparedClient } from "./prepare";
import { snpIdentity, type TrusteeSnpIdentity } from "nebula-cdk8s/trustee/policies";

export interface RuntimeOptions {
  readonly stateDirectory: string;
  /** Absolute path to the qualified native TNG client. Never downloaded on connect. */
  readonly tngBinary: string;
  /** Retained for caller compatibility; verification no longer starts Docker. */
  readonly dockerBinary?: string;
  readonly signal?: AbortSignal;
}

/** Built-in Trustee appraisal uses verified raw SNP claims. These differ from
 * normalized KBS EAR claims: measurement is base64 and policy bits are strings. */
export function nativeVerification(identity: TrusteeSnpIdentity) {
  const approved = snpIdentity(identity);
  const policy = `package policy
import rego.v1
default executables := 33
default hardware := 97
default configuration := 36
default file_system := 35
executables := 3 if approved
hardware := 2 if approved
configuration := 2 if approved
file_system := 2 if approved
approved if {
  input.init_data == ${JSON.stringify(approved.initDataSha256)}
  input.snp.measurement == ${JSON.stringify(Buffer.from(approved.measurement, "hex").toString("base64"))}
  input.snp.chip_id == ${JSON.stringify(approved.chipId)}
  input.snp.policy_debug_allowed == "0"
  input.snp.policy_migrate_ma == "0"
  ${Object.entries(approved.minimumReportedTcb).map(([field, floor]) => `to_number(input.snp.reported_tcb_${field}) >= ${floor}`).join("\n  ")}
}`;
  return { model: "background_check", as_provider: "coco", as_type: "builtin",
    attestation_policy: { type: "inline", content: Buffer.from(policy).toString("base64") }, reference_values: [] };
}

/** Each tunnel verifies the certificate from its SAME live TLS connection.
 * No REST policy API, shared TCP listener, free-port handoff, or readiness probe
 * is part of the trust boundary. The Unix socket is private and held until close. */
export async function startRuntime(options: RuntimeOptions) {
  if (!isAbsolute(options.tngBinary)) throw new TypeError("tngBinary must be an absolute path to the qualified client");
  const { directory, profile } = readPreparedClient(options.stateDirectory);
  options.signal?.throwIfAborted();
  const lock = join(directory, "runtime.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, transport: "private-unix" }), { mode: 0o600, flag: "wx" });
  let temporary: string;
  try { temporary = mkdtempSync(join(tmpdir(), "nebula-ra-")); }
  catch (error) { rmSync(lock); throw error; }
  chmodSync(temporary, 0o700);
  const socketPath = join(temporary, "transport.sock"), stopped = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
  const sockets = new Set<Socket>(), pending = new Set<Promise<void>>();
  let sequence = 0, closing: Promise<void> | undefined;
  const assertAlive = () => signal.throwIfAborted();
  const configuration = JSON.stringify(nativeVerification(profile.identity));
  const server = createServer(downstream => {
    if (signal.aborted || pending.size >= 8) { downstream.destroy(); return; }
    sockets.add(downstream);
    downstream.once("close", () => sockets.delete(downstream));
    downstream.on("error", () => {});
    const operation = (async () => {
      let upstream: TLSSocket | undefined;
      const certFile = join(temporary, `peer-${sequence++}.der`);
      const startup = new AbortController();
      const timeout = setTimeout(() => startup.abort(new Error("RA-TLS verification timed out")), 30_000);
      const deadline = AbortSignal.any([signal, startup.signal]);
      const abortPeer = () => upstream?.destroy(new Error("RA-TLS connection aborted"));
      const queued: Buffer[] = [];
      let queuedBytes = 0, forwarding = false;
      const buffer = (chunk: Buffer) => {
        queuedBytes += chunk.length;
        if (queuedBytes > 2 * 1024 * 1024 + 65536) {
          startup.abort(new Error("Unverified local request exceeds its limit")); downstream.destroy();
        } else queued.push(chunk);
      };
      try {
        assertAlive();
        upstream = connect({ host: profile.target.host, port: profile.target.port,
          ...(isIP(profile.target.host) ? {} : { servername: profile.target.host }),
          minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["rats-tls"],
          // Authentication is the qualified TNG verifier below; no public CA or
          // host-reported certificate metadata substitutes for attestation.
          rejectUnauthorized: false });
        deadline.addEventListener("abort", abortPeer, { once: true });
        if (deadline.aborted) abortPeer();
        const peer = upstream;
        sockets.add(peer);
        peer.once("close", () => { sockets.delete(peer); downstream.destroy(); });
        peer.on("error", () => downstream.destroy());
        downstream.once("close", () => {
          startup.abort(new Error("Local request closed during verification"));
          peer.destroy();
        });
        downstream.once("end", () => {
          if (!forwarding) { startup.abort(new Error("Local request ended during verification")); downstream.destroy(); }
        });
        // Read only into bounded owner-local memory until appraisal. Keeping
        // this socket paused would also hide EOF, leaving verifier children
        // alive after their caller cancelled the request.
        downstream.on("data", buffer);
        peer.pause(); // bound unsolicited input until appraisal finishes
        await new Promise<void>((accept, reject) => {
          peer.once("secureConnect", accept); peer.once("error", reject);
          peer.once("close", () => reject(new Error("RA-TLS peer closed before handshake")));
        });
        if (peer.alpnProtocol !== "rats-tls" || peer.getProtocol() !== "TLSv1.3") throw new Error("Unexpected RA-TLS protocol");
        const raw = peer.getPeerCertificate().raw;
        if (!raw || raw.length > 65536) throw new Error("Missing bounded peer certificate");
        const certificate = new X509Certificate(raw);
        if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error("Expired peer certificate");
        writeFileSync(certFile, raw, { mode: 0o600, flag: "wx" });
        await new Promise<void>((accept, reject) => {
          execFile(options.tngBinary, ["tools", "rats-tls", "verify", "--cert", certFile, "--verify", configuration],
            { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, signal: deadline,
              env: { ...process.env, RUST_LOG: "off", RUST_BACKTRACE: "0",
                TRUSTEE_SNP_VCEK_STORE: profile.offlineVcek ? join(directory, "kds-store") : undefined } },
            error => error ? reject(new Error("Native TNG rejected the live peer certificate")) : accept());
        });
        deadline.throwIfAborted(); assertAlive();
        if (peer.destroyed || downstream.destroyed) throw new Error("RA-TLS connection closed during verification");
        // Only now can HTTP bytes, an inner TLS handshake, or an owner secret
        // flow. There is no reconnect between the certificate check and use.
        downstream.pause(); forwarding = true; downstream.removeListener("data", buffer);
        for (const chunk of queued) peer.write(chunk);
        queued.length = 0;
        downstream.pipe(peer).pipe(downstream);
        downstream.resume(); peer.resume();
      } catch { downstream.destroy(); upstream?.destroy(); }
      finally {
        if (!forwarding) for (const chunk of queued) chunk.fill(0);
        queued.length = 0;
        clearTimeout(timeout); deadline.removeEventListener("abort", abortPeer); rmSync(certFile, { force: true });
      }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  });
  const close = (): Promise<void> => closing ??= (async () => {
    stopped.abort(new Error("Trustee client is closed"));
    options.signal?.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(accept => server.close(() => accept()));
    await Promise.allSettled(pending);
    rmSync(temporary, { recursive: true, force: true });
    rmSync(lock);
  })();
  const abort = () => { void close(); };
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject); server.listen(socketPath, accept);
    });
    chmodSync(socketPath, 0o600);
    server.on("error", () => { void close(); });
    options.signal?.addEventListener("abort", abort, { once: true });
    assertAlive();
    return { socketPath, signal, assertAlive, close };
  } catch (error) { await close(); throw error; }
}
