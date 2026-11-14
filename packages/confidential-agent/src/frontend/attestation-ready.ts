import { randomBytes, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync,
  statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const directory = "/run/browser", marker = `${directory}/asr-ready`;

async function publicJson(path: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`http://127.0.0.1:8007${path}`, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Frontend attestation unavailable");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) throw new Error("Oversized frontend attestation response");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Warm only the proxy's public VCEK cache. Each attempt and TNG's subsequent
 * key-bound quote use a fresh runtime_data value; evidence is never retained. */
export async function awaitFrontendAttestation(signal: AbortSignal): Promise<void> {
  let backoff = 1_000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const info = await publicJson("/info", signal);
      if (info?.tee !== "snp") throw new Error("Frontend requires SNP attestation");
      const nonce = randomBytes(32).toString("base64url");
      const evidence = await publicJson(`/aa/evidence?encoding=base64&runtime_data=${nonce}`, signal);
      const vcek = Array.isArray(evidence?.cert_chain) && evidence.cert_chain.find((item: any) => item?.cert_type === "VCEK");
      if (!evidence?.attestation_report || !vcek || !Array.isArray(vcek.data) ||
          vcek.data.length < 256 || vcek.data.length > 16 * 1024 ||
          vcek.data.some((item: unknown) => !Number.isInteger(item) || Number(item) < 0 || Number(item) > 255)) {
        throw new Error("Frontend public collateral unavailable");
      }
      const der = Buffer.from(vcek.data);
      if (!new X509Certificate(der).raw.equals(der)) throw new Error("Invalid frontend public collateral");
      // Readiness checks syntax/availability only. The independent verifier
      // still checks AMD trust, report signature, TCB and the fresh TNG key.
      signal.throwIfAborted();
      return;
    } catch {
      signal.throwIfAborted();
      // Transient AA/KDS failures must not kill a create-once frontend. Each
      // request is bounded, and the same process retries until shutdown.
      await delay(backoff, undefined, { signal });
      backoff = Math.min(8_000, backoff * 2);
    }
  }
}

/** The only publisher is the measured frontend. TNG sees this guest-memory
 * directory read-only and cannot start until public attestation is available. */
export async function prewarmFrontendAttestation(signal: AbortSignal): Promise<void> {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory ||
      Number(statfsSync(directory).type) !== 0x01021994) throw new Error("Frontend readiness requires guest memory");
  await awaitFrontendAttestation(signal);
  signal.throwIfAborted();
  let file: number | undefined, published: { ino: number; dev: number } | undefined;
  const cleanup = () => {
    if (!published) return;
    try {
      const current = lstatSync(marker);
      if (current.ino === published.ino && current.dev === published.dev && current.isFile() && !current.isSymbolicLink()) unlinkSync(marker);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { published = undefined; }
  };
  try {
    file = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600) {
      throw new Error("Invalid frontend readiness marker");
    }
    published = { ino: info.ino, dev: info.dev };
    writeFileSync(file, "ready\n"); fsyncSync(file); closeSync(file); file = undefined;
    signal.addEventListener("abort", cleanup, { once: true });
    if (signal.aborted) cleanup();
    signal.throwIfAborted();
  } catch (error) {
    cleanup(); throw error;
  } finally { if (file !== undefined) closeSync(file); }
}
