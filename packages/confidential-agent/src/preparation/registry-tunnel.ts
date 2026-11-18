import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { connect, isIP, type Socket } from "node:net";

const QUEUE_BYTES = 4 * 1024 * 1024, WRITE_BYTES = 1024 * 1024;
const MAX_TRANSFER = 16 * 1024 ** 3, MAX_SESSIONS = 4;
const IDLE_MS = 5 * 60_000, LIFETIME_MS = 2 * 60 * 60_000;
const failure = () => new Error("Registry source connection is unavailable");

/** Registry source TLS terminates in the browser. This module forwards opaque
 * bytes to one pinned public address on port 443, never HTTP or credentials. */
export function publicRegistryAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const value = parts.reduce((n, p) => (n * 256 + p) >>> 0, 0);
    const inRange = (base: number, bits: number) => (value >>> (32 - bits)) === (base >>> (32 - bits));
    return ![
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ].some(([base, bits]) => inRange(base, bits));
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const halves = address.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (words.length !== 8) return false;
  const value = words.reduce((n, word) => n * 65536n + BigInt(parseInt(word, 16)), 0n);
  const prefix = (base: bigint, bits: bigint) => (value >> (128n - bits)) === (base >> (128n - bits));
  return prefix(0x20000000000000000000000000000000n, 3n) &&
    !prefix(0x20010000000000000000000000000000n, 23n) &&
    !prefix(0x20010db8000000000000000000000000n, 32n) &&
    !prefix(0x20020000000000000000000000000000n, 16n) &&
    !prefix(0x3fff0000000000000000000000000000n, 20n);
}

export function registrySourceHost(host: unknown): string {
  if (typeof host !== "string" || host.length > 253 || host !== host.toLowerCase() || isIP(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|svc|cluster|arpa|onion|test|invalid|example)$/.test(host)) throw failure();
  return host;
}

interface Session {
  socket: Socket; created: number; touched: number; received: number; sent: number;
  chunks: Buffer[]; bytes: number; ended: boolean; failed: boolean; reading: boolean; writing: boolean;
  wake?: () => void;
}
interface TunnelNetwork {
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  connect(address: string, family: number): Socket;
}

export class RegistryTunnels {
  private readonly sessions = new Map<string, Session>();
  private pending = 0;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly network: TunnelNetwork;
  constructor(signal?: AbortSignal, network?: TunnelNetwork) {
    this.network = network ?? {
      lookup: host => lookup(host, { all: true, verbatim: true }),
      connect: (address, family) => connect({ host: address, family, port: 443 }),
    };
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of this.sessions) if (now - state.touched > IDLE_MS || now - state.created > LIFETIME_MS) this.close(id);
    }, 15_000);
    this.timer.unref();
    if (signal?.aborted) this.stop();
    else signal?.addEventListener("abort", () => this.stop(), { once: true });
  }
  private state(id: string) {
    const state = this.sessions.get(id);
    if (!state || state.failed || Date.now() - state.created > LIFETIME_MS || Date.now() - state.touched > IDLE_MS) {
      if (state) this.close(id);
      throw failure();
    }
    state.touched = Date.now(); return state;
  }
  async create(host: unknown) {
    const name = registrySourceHost(host);
    if (this.stopped || this.sessions.size + this.pending >= MAX_SESSIONS) throw failure();
    this.pending++;
    let socket: Socket | undefined;
    try {
      let lookupTimer: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([this.network.lookup(name), new Promise<never>((_resolve, reject) => {
        lookupTimer = setTimeout(() => reject(failure()), 10_000);
      })]).finally(() => clearTimeout(lookupTimer));
      if (!results.length || results.length > 16 || results.some(r => !publicRegistryAddress(r.address))) throw failure();
      const selected = results.find(r => r.family === 4) ?? results[0];
      if (this.stopped) throw failure();
      socket = this.network.connect(selected.address, selected.family);
      const state: Session = { socket, created: Date.now(), touched: Date.now(), received: 0, sent: 0,
        chunks: [], bytes: 0, ended: false, failed: false, reading: false, writing: false };
      const fail = () => { state.failed = true; state.wake?.(); socket?.destroy(); };
      socket.on("data", (raw: Buffer) => {
        state.received += raw.length;
        if (state.received > MAX_TRANSFER || state.bytes + raw.length > QUEUE_BYTES + 128 * 1024) { fail(); return; }
        state.chunks.push(raw); state.bytes += raw.length; state.touched = Date.now();
        if (state.bytes >= QUEUE_BYTES) socket?.pause();
        state.wake?.();
      });
      socket.on("error", fail);
      socket.on("end", () => { state.ended = true; state.wake?.(); });
      socket.on("close", () => { state.ended = true; state.wake?.(); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket?.destroy(); reject(failure()); }, 10_000);
        const error = () => { clearTimeout(timer); reject(failure()); };
        socket!.once("error", error);
        socket!.once("connect", () => { clearTimeout(timer); socket!.off("error", error); resolve(); });
      });
      if (this.stopped || state.failed) throw failure();
      const id = randomUUID(); this.sessions.set(id, state);
      return { id };
    } catch { socket?.destroy(); throw failure(); }
    finally { this.pending--; }
  }
  async write(id: string, raw: Buffer) {
    const state = this.state(id);
    if (!raw.length || raw.length > WRITE_BYTES || state.writing || state.ended || state.sent + raw.length > MAX_TRANSFER) throw failure();
    state.writing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.close(id); reject(failure()); }, 30_000);
        state.socket.write(raw, error => { clearTimeout(timer); error ? reject(failure()) : resolve(); });
      });
      state.sent += raw.length; state.touched = Date.now(); return { written: raw.length };
    } finally { state.writing = false; }
  }
  async read(id: string) {
    const state = this.state(id);
    if (state.reading) throw failure();
    state.reading = true;
    try {
      if (!state.bytes && !state.ended && !state.failed) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { state.wake = undefined; resolve(); }, 15_000);
        state.wake = () => { clearTimeout(timer); state.wake = undefined; resolve(); };
      });
      if (state.bytes && state.bytes < QUEUE_BYTES && !state.ended && !state.failed) await new Promise(resolve => setTimeout(resolve, 20));
      if (state.failed || this.stopped) throw failure();
      const chunks: Buffer[] = []; let count = 0;
      while (state.chunks.length && count < QUEUE_BYTES) {
        const part = state.chunks[0], remaining = QUEUE_BYTES - count;
        if (part.length <= remaining) { chunks.push(part); count += part.length; state.chunks.shift(); }
        else { chunks.push(part.subarray(0, remaining)); state.chunks[0] = part.subarray(remaining); count += remaining; }
      }
      state.bytes -= count; state.touched = Date.now();
      if (state.bytes < QUEUE_BYTES / 2 && !state.ended) state.socket.resume();
      return { version: 1, data: Buffer.concat(chunks, count).toString("base64"), eof: state.ended && state.bytes === 0 };
    } finally { state.reading = false; }
  }
  close(id: string) {
    const state = this.sessions.get(id);
    if (state) { this.sessions.delete(id); state.failed = true; state.wake?.(); state.socket.destroy(); state.chunks = []; state.bytes = 0; }
  }
  stop() {
    this.stopped = true; clearInterval(this.timer);
    for (const id of this.sessions.keys()) this.close(id);
  }
}
