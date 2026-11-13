import { createServer } from "node:http";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PUBLIC_KDS = "/run/nebula-public-kds";
const CERT_LIMIT = 16 * 1024;
type CollateralStage = "public-collateral-report" | "public-collateral-fetch" | "public-collateral-store";

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (response.status !== 200 || !response.body) throw new Error("Public collateral unavailable");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new Error("Oversized public collateral");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); }
}

function certificate(bytes: Buffer): Buffer {
  if (bytes.length < 256 || bytes.length > CERT_LIMIT) throw new Error("Invalid public certificate size");
  const parsed = new X509Certificate(bytes);
  if (!parsed.raw.equals(bytes) || Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now()) {
    throw new Error("Invalid public certificate encoding or validity");
  }
  // This parses public DER only. Native KBS remains the AMD trust, signature,
  // chip-ID, exact reported-TCB and attestation-policy verifier.
  return bytes;
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700) throw new Error("Invalid public collateral directory");
}

function entries(path: string, limit: number): string[] {
  const directory = opendirSync(path), result: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return result;
      if (result.length === limit) throw new Error("Unexpected public collateral files");
      result.push(entry.name);
    }
  } finally { directory.closeSync(); }
}

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > CERT_LIMIT) {
    throw new Error("Invalid public collateral file");
  }
}

function readCertificate(path: string): Buffer | undefined {
  let file: number | undefined;
  try {
    privateFile(path);
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 ||
        info.nlink !== 1 || info.size < 256 || info.size > CERT_LIMIT) throw new Error("Invalid public collateral file");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Incomplete public collateral file");
      offset += count;
    }
    return certificate(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { if (file !== undefined) closeSync(file); }
}

function publishCertificate(directory: string, name: string, bytes: Buffer): void {
  const temporary = `${directory}/.vcek-${randomBytes(16).toString("hex")}.tmp`;
  let file: number | undefined;
  try {
    file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, bytes); fsyncSync(file); closeSync(file); file = undefined;
    renameSync(temporary, `${directory}/${name}`);
  } finally {
    if (file !== undefined) closeSync(file);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function retry<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt === 2) throw error;
      await delay(1_000, undefined, { signal });
    }
  }
}

/** Publish one bounded public VCEK for the current measured SNP instance before
 * owner access starts. No request can supply a URL, path or trust decision. */
export async function prefetchSnpCollateral(signal: AbortSignal, stage: (value: CollateralStage) => void = () => {}): Promise<void> {
  stage("public-collateral-report");
  const evidence = await retry(signal, async () => {
    const nonce = randomBytes(32).toString("base64url");
    const response = await fetch(`http://127.0.0.1:8006/aa/evidence?encoding=base64&runtime_data=${nonce}`,
      { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
    return JSON.parse((await boundedBody(response, 128 * 1024)).toString("utf8"));
  });
  const address = snpKdsUrl(evidence.attestation_report);
  // Native OfflineStore uses the full report CHIP_ID directory. The AMD URL
  // independently uses the generation-specific KDS identifier (8 bytes for
  // Turin); never reuse that shortened URL component as a filesystem identity.
  const hardware = Buffer.from(evidence.attestation_report.chip_id).toString("hex");
  if (!/^[a-f0-9]{128}$/.test(hardware)) throw new Error("Invalid public collateral identity");
  const name = `source-${createHash("sha256").update(address).digest("hex")}.der`;
  stage("public-collateral-store");
  const root = lstatSync(PUBLIC_KDS);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(PUBLIC_KDS) !== PUBLIC_KDS ||
      Number(statfsSync(PUBLIC_KDS).type) !== 0x01021994 || entries(PUBLIC_KDS, 1).some(item => item !== "vcek")) {
    throw new Error("Public collateral requires dedicated guest memory");
  }
  privateDirectory(`${PUBLIC_KDS}/vcek`);
  if (entries(`${PUBLIC_KDS}/vcek`, 1).some(item => item !== hardware)) throw new Error("Stale public collateral identity");
  const directory = `${PUBLIC_KDS}/vcek/${hardware}`;
  privateDirectory(directory);
  // At most four small DER/temporary files can exist after an interrupted
  // publication. Prune only our strictly validated stale public files. The
  // completed layout has exactly one current source DER and one native DER.
  for (const item of entries(directory, 4)) {
    if (!(item === "vcek.der" || /^source-[a-f0-9]{64}\.der$/.test(item) || /^\.vcek-[a-f0-9]{32}\.tmp$/.test(item))) {
      throw new Error("Unexpected public collateral file");
    }
    privateFile(`${directory}/${item}`);
    if (item !== "vcek.der" && item !== name) unlinkSync(`${directory}/${item}`);
  }
  let bytes = readCertificate(`${directory}/${name}`);
  if (!bytes) {
    stage("public-collateral-fetch");
    // Evidence may contain the public VCEK itself; never follow a URL supplied
    // by evidence. Otherwise download only the fixed AMD URL derived above.
    const embedded = Array.isArray(evidence.cert_chain) ? evidence.cert_chain.find((entry: any) => entry?.cert_type === "VCEK") : undefined;
    if (embedded) {
      if (!Array.isArray(embedded.data) || embedded.data.length > CERT_LIMIT ||
          embedded.data.some((item: unknown) => !Number.isInteger(item) || Number(item) < 0 || Number(item) > 255)) throw new Error("Invalid public collateral bytes");
      bytes = certificate(Buffer.from(embedded.data));
    } else bytes = await retry(signal, async () => certificate(await boundedBody(await fetch(address,
      { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }), CERT_LIMIT)));
    stage("public-collateral-store");
    publishCertificate(directory, name, bytes);
  }
  signal.throwIfAborted();
  publishCertificate(directory, "vcek.der", bytes);
}

/** Public AMD collateral is supplied with evidence so browsers never depend on
 * AMD KDS CORS. It is not a trust anchor: the browser checks the AMD chain,
 * report signature, chip ID and exact reported TCB independently. */
export function snpKdsUrl(report: any): string {
  const chip = report?.chip_id;
  if (!Array.isArray(chip) || chip.length !== 64 || chip.some(b => !Number.isInteger(b) || b < 0 || b > 255) ||
      !chip.some(b => b !== 0) || !Number.isInteger(report.version) || report.version < 2 || report.version > 5) {
    throw new Error("Invalid SNP report");
  }
  const modern = report.key_info !== undefined;
  const [family, model] = modern ? [report.cpuid_fam_id, report.cpuid_mod_id] : report._reserved_1 ?? [];
  const short = chip.slice(8).every(b => b === 0);
  const generation = report.version < 3 ? (short ? "Turin" : "Milan") :
    family === 0x1a && model <= 0x11 ? "Turin" : family === 0x19 && model <= 0x0f ? "Milan" :
      family === 0x19 && ((model >= 0x10 && model <= 0x1f) || (model >= 0xa0 && model <= 0xaf)) ? "Genoa" : undefined;
  if (!generation) throw new Error("Unsupported SNP generation");
  const t = report.reported_tcb;
  const values = generation === "Turin" ? (modern
    ? { fmcSPL: t.fmc, blSPL: t.bootloader, teeSPL: t.tee, snpSPL: t.snp, ucodeSPL: t.microcode }
    : { fmcSPL: t.bootloader, blSPL: t.tee, teeSPL: t._reserved[0], snpSPL: t._reserved[1], ucodeSPL: t.microcode })
    : { blSPL: t.bootloader, teeSPL: t.tee, snpSPL: t.snp, ucodeSPL: t.microcode };
  if (Object.values(values).some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error("Invalid SNP TCB");
  const id = Buffer.from(chip.slice(0, generation === "Turin" ? 8 : 64)).toString("hex");
  return `https://kdsintf.amd.com/vcek/v1/${generation}/${id}?${new URLSearchParams(Object.entries(values).map(([k,v]) => [k, String(v).padStart(2, "0")]))}`;
}

export function collateralProxy(port = 8007) {
  const certificates = new Map<string, number[]>();
  const server = createServer(async (incoming, outgoing) => {
    incoming.resume();
    const url = new URL(incoming.url ?? "", "http://localhost");
    if (incoming.method !== "GET" || !(url.pathname === "/info" || url.pathname === "/aa/evidence")) {
      outgoing.writeHead(404).end(); return;
    }
    if (url.pathname === "/aa/evidence" && (url.searchParams.get("encoding") !== "base64" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get("runtime_data") ?? "") ||
        [...url.searchParams.keys()].sort().join() !== "encoding,runtime_data")) { outgoing.writeHead(400).end(); return; }
    let stage = "attestation-agent";
    try {
      const response = await fetch(`http://127.0.0.1:8006${url.pathname}${url.search}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw new Error("Attestation Agent unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 128 * 1024) throw new Error("Oversized evidence");
      stage = "evidence-format";
      const evidence = JSON.parse(new TextDecoder().decode(bytes));
      if (url.pathname === "/aa/evidence" && !evidence.cert_chain?.length) {
        const address = snpKdsUrl(evidence.attestation_report);
        let cert = certificates.get(address);
        if (!cert) {
          stage = "amd-collateral";
          const collateral = await fetch(address, { redirect: "error", signal: AbortSignal.timeout(20_000) });
          if (collateral.status !== 200) throw new Error("AMD collateral unavailable");
          const body = new Uint8Array(await collateral.arrayBuffer());
          if (body.length < 512 || body.length > 16 * 1024) throw new Error("Invalid collateral size");
          cert = [...body];
          certificates.clear(); certificates.set(address, cert);
        }
        evidence.cert_chain = [{ cert_type: "VCEK", data: cert }];
      }
      outgoing.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(evidence));
    } catch { outgoing.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "SNP evidence unavailable", stage })); }
  });
  server.maxConnections = 16;
  return server.listen(port, "127.0.0.1");
}
