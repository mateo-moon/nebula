import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { type Duplex } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseAgentConfig, type AgentConfig } from "./config.js";
import { installGuestGuard } from "./guard.js";
import { awaitOwner, awaitOwnerReady, monitorOwnerReadiness } from "./await-owner.js";
import { gatewayConfigured, loadOrCreateIdentity, startGateway } from "./gateway.js";
import { collateralProxy, prefetchSnpCollateral } from "./snp-collateral.js";
import { AgentLifecycle } from "./lifecycle.js";

const native = "/usr/local/bin/nebula-confidential-storage";
declare const NEBULA_AGENT_WORKLOAD_MODULE: boolean;
declare const NEBULA_AGENT_BROWSER_MODULES: boolean;

// A fixed startup stage can be exposed in the Pod termination message without
// disclosing measured arguments, native errors, resource paths or key material.
export let agentStartupStage = "config";

/** KBS creates this directory atomically inside the same measured PodVM.
 * Restartable init containers start in order, but "started" does not mean
 * KBS has finished its guest-local bootstrap. The gateway validates the key
 * and its public half after this directory appears. */
export async function awaitInternalOwnerBootstrap(directory: string, signal: AbortSignal): Promise<void> {
  const keyDirectory = join(directory, "internal-owner");
  for (let attempt = 0; attempt < 120; attempt++) {
    signal.throwIfAborted();
    if (existsSync(keyDirectory)) return;
    await delay(500, undefined, { signal });
  }
  throw new Error("Guest-internal owner bootstrap unavailable");
}

/** One inherited Unix socket; no public path, port, key or arbitrary command. */
export function nativeStorageControl(child: ChildProcess) {
  const channel = child.stdio[3] as Duplex | null;
  if (!channel || typeof channel.write !== "function") throw new Error("Native module channel unavailable");
  let buffer = "", initialized = false, sequence = 0, closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = () => {
    if (closed) return; closed = true;
    const error = new Error("Native storage control unavailable"); readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const timer = setTimeout(() => { fail(); channel.destroy(); }, 10_000);
  channel.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8");
    if (buffer.length > 65536) { fail(); channel.destroy(); return; }
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!initialized) {
        if (line !== "nebula-storage-module-v1") { fail(); channel.destroy(); return; }
        initialized = true; clearTimeout(timer); readyResolve(); continue;
      }
      try {
        const value = JSON.parse(line), item = pending.get(value.id);
        if (!item || Object.keys(value).sort().join() !== ("error" in value ? "error,id" : "id,result")) throw new Error();
        pending.delete(value.id); clearTimeout(item.timer);
        if ("error" in value) item.reject(new Error("Native recovery request refused")); else item.resolve(value.result);
      } catch { fail(); channel.destroy(); return; }
    }
  });
  channel.once("error", fail); channel.once("end", fail); child.once("error", fail); child.once("exit", fail);
  ready.finally(() => clearTimeout(timer)).catch(() => {});
  const request = async (op: "bind" | "plans" | "apply" | "ready", fields: Record<string, unknown> = {}) => {
    await ready;
    if (closed || pending.size >= 8 || sequence >= 0x7fffffff) throw new Error("Native storage control unavailable");
    const id = ++sequence, raw = JSON.stringify({ id, op, ...fields }) + "\n";
    if (Buffer.byteLength(raw) > 8192) throw new Error("Invalid native request");
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Native storage control timed out")); }, 5000);
      pending.set(id, { resolve, reject, timer: timeout });
      channel.write(raw, error => { if (error) fail(); });
    });
  };
  return { ready, bind: (instance: string) => request("bind", { instance }),
    plans: () => request("plans"), apply: (value: unknown) => request("apply", { request: value }),
    modulesReady: async () => {
      const value = await request("ready") as { ready?: unknown };
      if (!value || Object.keys(value).join() !== "ready" || typeof value.ready !== "boolean") throw new Error("Invalid native readiness response");
      return value.ready;
    } };
}

/** Privileged setup finishes before any owner-facing listener starts. The
 * native disk module keeps only its required capabilities; the HTTP agent
 * drops permanently to the measured helper UID. */
async function initializeWorkload(config: Extract<AgentConfig, { role: "workload" }>, lifecycle: AgentLifecycle): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 0) {
    throw new Error("Workload agent requires guest root on Linux SNP");
  }
  agentStartupStage = "guest-guard";
  installGuestGuard();
  agentStartupStage = "native-install";
  execFileSync(native, ["install"], { stdio: "ignore", timeout: 15_000 });
  let control: ReturnType<typeof nativeStorageControl> | undefined;
  if (config.storage.volumes.length || config.storage.clients.length) {
    agentStartupStage = "native-start";
    const child = spawn(native, ["agent", JSON.stringify(config.storage)], {
      stdio: ["pipe", "ignore", "ignore", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    lifecycle.native(child);
    control = nativeStorageControl(child);
    await control.ready;
  }
  agentStartupStage = "privilege-drop";
  lifecycle.signal.throwIfAborted();
  process.setgroups!([10001]);
  process.setgid!(10001);
  process.setuid!(10001);
  if (process.getuid?.() !== 10001 || process.getgid?.() !== 10001) throw new Error("Agent privilege drop failed");
  await prefetchSnpCollateral(lifecycle.signal, stage => { agentStartupStage = stage; });
  const owner = config.owner;
  let ready = false;
  if (owner.ownerClaimSha256) {
    agentStartupStage = "internal-owner-bootstrap";
    await awaitInternalOwnerBootstrap("/run/instance", lifecycle.signal);
  }
  agentStartupStage = "owner-gateway";
  if (control) {
    const certificate = new X509Certificate(loadOrCreateIdentity("/run/instance").cert);
    const instance = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    await control.bind(instance);
  }
  const gateway = startGateway("/run/instance", owner.storageNames, owner.resources,
    owner.ownerClaimSha256, owner.audience, owner.browser, () => ready, control);
  lifecycle.server(gateway);
  lifecycle.task(awaitOwner(owner.resources, lifecycle.signal, undefined,
    async () => gatewayConfigured(gateway)).then(() => monitorOwnerReadiness(lifecycle.signal,
      () => control ? control.modulesReady() : Promise.resolve(true),
      value => { ready = value; agentStartupStage = value ? "running" : "native-storage"; })));
  agentStartupStage = "running";
}

export async function startAgent(raw: string, lifecycle = new AgentLifecycle()): Promise<AgentLifecycle> {
  const config = parseAgentConfig(raw);
  process.umask(0o077);
  try {
    if (config.role === "owner-gate") {
      if (!NEBULA_AGENT_WORKLOAD_MODULE || process.platform !== "linux" || process.getuid?.() !== 10001) {
        throw new Error("Owner gate requires the unprivileged workload runtime");
      }
      agentStartupStage = "owner-gate";
      lifecycle.task(awaitOwnerReady(lifecycle.signal).then(() => { void lifecycle.close(); }));
      return lifecycle;
    }
    if (config.role === "workload") {
      if (!NEBULA_AGENT_WORKLOAD_MODULE) throw new Error("This agent release does not contain workload modules");
      if (NEBULA_AGENT_WORKLOAD_MODULE) await initializeWorkload(config, lifecycle);
    } else if (NEBULA_AGENT_BROWSER_MODULES && config.role === "preparation") {
      const { startPreparation } = await import("./preparation/server.js");
      lifecycle.signal.throwIfAborted();
      for (const server of startPreparation("/app/ui", config.maxImageSizeMiB, lifecycle.signal,
        task => lifecycle.task(task))) lifecycle.server(server);
    } else if (NEBULA_AGENT_BROWSER_MODULES && config.role === "frontend") {
      const { startManualTls } = await import("./frontend/server.js");
      lifecycle.signal.throwIfAborted();
      lifecycle.server(startManualTls({ ...config.entry, assets: "/app/loader" }));
      lifecycle.server(collateralProxy());
      const { prewarmFrontendAttestation } = await import("./frontend/attestation-ready.js");
      agentStartupStage = "frontend-attestation";
      lifecycle.task(prewarmFrontendAttestation(lifecycle.signal).then(() => { agentStartupStage = "running"; }));
      return lifecycle;
    } else throw new Error("This agent release does not contain browser modules");
    if (config.role !== "workload" || config.owner.browser) lifecycle.server(collateralProxy());
    return lifecycle;
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
}
