import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseAgentConfig, type AgentConfig } from "./config.js";
import { installGuestGuard } from "./guard.js";
import { awaitOwner, awaitOwnerReady, publishOwnerReady } from "./await-owner.js";
import { gatewayConfigured, startGateway } from "./gateway.js";
import { collateralProxy } from "./snp-collateral.js";
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
  if (config.storage.volumes.length || config.storage.clients.length) {
    agentStartupStage = "native-start";
    const child = spawn(native, ["agent", JSON.stringify(config.storage)], {
      stdio: ["pipe", "ignore", "ignore", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    lifecycle.native(child);
    await new Promise<void>((resolve, reject) => {
      const channel = child.stdio[3];
      if (!channel || !("on" in channel)) { reject(new Error("Native module startup channel unavailable")); return; }
      let receipt = "";
      const timeout = setTimeout(() => reject(new Error("Native module startup timed out")), 10_000);
      channel.on("data", bytes => {
        receipt += String(bytes);
        if (receipt.length > 64) { clearTimeout(timeout); reject(new Error("Invalid native module startup")); }
      });
      channel.once("end", () => {
        clearTimeout(timeout);
        if (receipt === "nebula-storage-module-v1\n") resolve(); else reject(new Error("Native module did not initialize"));
      });
      channel.once("error", () => { clearTimeout(timeout); reject(new Error("Native module startup failed")); });
      child.once("error", () => { clearTimeout(timeout); reject(new Error("Native module startup failed")); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Native module stopped during startup")); });
    });
  }
  agentStartupStage = "privilege-drop";
  lifecycle.signal.throwIfAborted();
  process.setgroups!([10001]);
  process.setgid!(10001);
  process.setuid!(10001);
  if (process.getuid?.() !== 10001 || process.getgid?.() !== 10001) throw new Error("Agent privilege drop failed");
  const owner = config.owner;
  let ready = false;
  if (owner.ownerClaimSha256) {
    agentStartupStage = "internal-owner-bootstrap";
    await awaitInternalOwnerBootstrap("/run/instance", lifecycle.signal);
  }
  agentStartupStage = "owner-gateway";
  const gateway = startGateway("/run/instance", owner.storageNames, owner.resources,
    owner.ownerClaimSha256, owner.audience, owner.browser, () => ready);
  lifecycle.server(gateway);
  lifecycle.task(awaitOwner(owner.resources, lifecycle.signal, undefined,
    async () => gatewayConfigured(gateway)).then(() => {
      if (!lifecycle.signal.aborted) { publishOwnerReady(); ready = true; }
    }));
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
    } else throw new Error("This agent release does not contain browser modules");
    if (config.role !== "workload" || config.owner.browser) lifecycle.server(collateralProxy());
    return lifecycle;
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
}
