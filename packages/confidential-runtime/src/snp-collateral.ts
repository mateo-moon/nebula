import { createServer } from "node:http";

/** Public AMD collateral is supplied with evidence so browsers never depend on
 * AMD KDS CORS. It is not a trust anchor: the browser checks the AMD chain,
 * report signature, chip ID and exact reported TCB independently. */
export function snpKdsUrl(report: any): string {
  const chip = report?.chip_id;
  if (!Array.isArray(chip) || chip.length !== 64 || chip.some(b => !Number.isInteger(b) || b < 0 || b > 255) ||
      !chip.some(b => b !== 0) || !Number.isInteger(report.version) || report.version < 2 || report.version > 5) {
    throw new Error("Invalid SNP report");
  }
  const [family, model] = report._reserved_1 ?? [];
  const short = chip.slice(8).every(b => b === 0);
  const generation = report.version < 3 ? (short ? "Turin" : "Milan") :
    family === 0x1a && model <= 0x11 ? "Turin" : family === 0x19 && model <= 0x0f ? "Milan" :
      family === 0x19 && ((model >= 0x10 && model <= 0x1f) || (model >= 0xa0 && model <= 0xaf)) ? "Genoa" : undefined;
  if (!generation) throw new Error("Unsupported SNP generation");
  const t = report.reported_tcb;
  const values = generation === "Turin" ? { fmcSPL: t.bootloader, blSPL: t.tee, teeSPL: t._reserved[0], snpSPL: t._reserved[1], ucodeSPL: t.microcode }
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
    try {
      const response = await fetch(`http://127.0.0.1:8006${url.pathname}${url.search}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw new Error("Attestation Agent unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 128 * 1024) throw new Error("Oversized evidence");
      const evidence = JSON.parse(new TextDecoder().decode(bytes));
      if (url.pathname === "/aa/evidence" && !evidence.cert_chain?.length) {
        const address = snpKdsUrl(evidence.attestation_report);
        let cert = certificates.get(address);
        if (!cert) {
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
    } catch { outgoing.writeHead(503).end(); }
  });
  server.maxConnections = 16;
  return server.listen(port, "127.0.0.1");
}
