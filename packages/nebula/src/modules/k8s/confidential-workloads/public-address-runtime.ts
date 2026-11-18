import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { request } from "node:https";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export interface PublicAddressRuntimeConfig {
  namespace: string; nodeName: string; workloadName: string; profile: string;
  ipAddress: string; podCidr: string; table: string;
}
interface Pod {
  metadata?: { uid?: string; deletionTimestamp?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string; runtimeClassName?: string; hostNetwork?: boolean };
  status?: { phase?: string; podIP?: string; conditions?: { type: string; status: string }[] };
}
export interface PublicAddressTarget { uid: string; ip: string }

const addressNumber = (value: string) => value.split(".").reduce((number, octet) => number * 256 + Number(octet), 0);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function inPodCidr(address: string, cidr: string): boolean {
  const [network, prefix, extra] = cidr.split("/");
  if (!isIPv4(address) || !isIPv4(network) || extra !== undefined || !/^(?:[89]|[12][0-9]|3[0-2])$/.test(prefix)) return false;
  const size = 2 ** (32 - Number(prefix));
  return Math.floor(addressNumber(address) / size) === Math.floor(addressNumber(network) / size);
}
export function validatePublicAddressConfig(value: PublicAddressRuntimeConfig): void {
  const name = /^[a-z][a-z0-9-]{0,62}$/;
  if (!value || Object.keys(value).sort().join() !== "ipAddress,namespace,nodeName,podCidr,profile,table,workloadName" ||
      ![value.namespace, value.workloadName, value.profile].every(item => typeof item === "string" && name.test(item)) ||
      typeof value.nodeName !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(value.nodeName) ||
      typeof value.ipAddress !== "string" || !isIPv4(value.ipAddress) ||
      /^(?:0|10|127|169\.254|192\.168)\./.test(value.ipAddress) ||
      addressNumber(value.ipAddress) >= addressNumber("224.0.0.0") ||
      addressNumber(value.ipAddress) >= addressNumber("172.16.0.0") && addressNumber(value.ipAddress) < addressNumber("172.32.0.0") ||
      typeof value.podCidr !== "string" || !inPodCidr(value.podCidr.split("/")[0], value.podCidr) ||
      !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(value.podCidr) ||
      typeof value.table !== "string" || !/^nebula_public_[a-f0-9]{16}$/.test(value.table)) {
    throw new TypeError("Invalid confidential public address configuration");
  }
  const [network, prefix] = value.podCidr.split("/"), size = 2 ** (32 - Number(prefix)), start = addressNumber(network);
  const privateRanges = [["10.0.0.0", "10.255.255.255"], ["172.16.0.0", "172.31.255.255"], ["192.168.0.0", "192.168.255.255"]];
  if (start % size !== 0 || !privateRanges.some(([first, last]) => start >= addressNumber(first) && start + size - 1 <= addressNumber(last))) {
    throw new TypeError("Confidential public address Pod CIDR must be a canonical private range");
  }
}

/** Names and labels select transport only. Attested guest/owner keys remain the
 * authority for enrollment; a replacement Pod never inherits those keys. */
export function selectPublicAddressTarget(pods: readonly Pod[], config: PublicAddressRuntimeConfig): PublicAddressTarget | undefined {
  const candidates = pods.filter(pod => !pod.metadata?.deletionTimestamp &&
    pod.metadata?.labels?.["confidential.nebula.dev/workload"] === config.workloadName &&
    pod.metadata?.labels?.["confidential.nebula.dev/profile"] === config.profile &&
    pod.spec?.nodeName === config.nodeName && pod.spec.runtimeClassName === "kata-qemu-snp" && !pod.spec.hostNetwork &&
    !["Succeeded", "Failed"].includes(pod.status?.phase ?? ""));
  if (candidates.length !== 1) return undefined;
  const pod = candidates[0], uid = pod.metadata?.uid, ip = pod.status?.podIP;
  if (typeof uid !== "string" || !uuid.test(uid) || !ip || !inPodCidr(ip, config.podCidr) ||
      pod.status?.phase !== "Running" || !pod.status.conditions?.some(item => item.type === "Ready" && item.status === "True")) return undefined;
  return { uid, ip };
}

/** A single nft transaction replaces only this allocation's own table. Earlier
 * DNAT/SNAT priorities precede the usual -100/100 service NAT chains; this IP
 * must not also be assigned to a Kubernetes Service or another host allocator.
 * The forwarding guard also closes established NAT flows when no target is
 * current, rather than leaving conntrack's previous translation usable. */
export function publicAddressRules(config: PublicAddressRuntimeConfig, target?: PublicAddressTarget, exists = false): string {
  validatePublicAddressConfig(config);
  if (target && (!uuid.test(target.uid) || !inPodCidr(target.ip, config.podCidr))) throw new TypeError("Invalid confidential public address target");
  const publicIp = config.ipAddress, protocols = "meta l4proto { tcp, udp }";
  const inbound = target ? `ip daddr ${publicIp} ${protocols} dnat to ${target.ip};` : "";
  const destinationGuard = target ? `ct direction original ip daddr != ${target.ip} ` : "";
  const sourceGuard = target ? `ct original ip saddr != ${target.ip} ` : "";
  return `${exists ? `delete table ip ${config.table}\n` : ""}table ip ${config.table} {
    chain inbound { type nat hook prerouting priority -110; policy accept; ${inbound} }
    chain local_inbound { type nat hook output priority -110; policy accept; ${inbound} }
    chain forwarded { type filter hook forward priority -150; policy accept;
      ct original ip daddr ${publicIp} ${destinationGuard}${protocols} reject
      ${target ? `ct original ip daddr ${publicIp} ct direction reply ip saddr != ${target.ip} ${protocols} reject` : ""}
      ct reply ip daddr ${publicIp} ${sourceGuard}${protocols} reject
    }
    chain host_input { type filter hook input priority -150; policy accept;
      ip daddr ${publicIp} ${protocols} reject
    }
    chain outbound { type nat hook postrouting priority 90; policy accept;
      ${target ? `ip saddr ${target.ip} ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16 } ${protocols} snat to ${publicIp}` : ""}
    }
  }\n`;
}

async function listPods(config: PublicAddressRuntimeConfig): Promise<Pod[]> {
  const selector = `confidential.nebula.dev/workload=${config.workloadName},confidential.nebula.dev/profile=${config.profile}`;
  const path = `/api/v1/namespaces/${config.namespace}/pods?labelSelector=${encodeURIComponent(selector)}&fieldSelector=${encodeURIComponent(`spec.nodeName=${config.nodeName}`)}`;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "kubernetes.default.svc", port: 443, path,
      ca: readFileSync("/run/kubernetes/ca.crt"), headers: { Authorization: `Bearer ${readFileSync("/run/kubernetes/token", "utf8").trim()}` },
      timeout: 10_000 }, response => {
      const data: Buffer[] = []; let length = 0;
      response.on("data", chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) req.destroy(new Error("Pod list exceeds its limit")); else data.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Pod list is unavailable");
          const value = JSON.parse(Buffer.concat(data).toString("utf8"));
          if (!Array.isArray(value.items) || value.items.length > 128) throw new Error("Invalid Pod list");
          resolve(value.items);
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Pod list timed out")));
    req.on("error", reject); req.end();
  });
}

export async function runPublicAddress(config: PublicAddressRuntimeConfig): Promise<void> {
  validatePublicAddressConfig(config);
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Public address routing requires a Linux host network namespace");
  let previous = "", stopped = false;
  const apply = (target?: PublicAddressTarget) => {
    const stamp = target ? `${target.uid}/${target.ip}` : "inactive";
    let exists = false;
    try { execFileSync("nft", ["list", "table", "ip", config.table], { stdio: "ignore", timeout: 5000 }); exists = true; } catch { /* First start or an externally removed table. */ }
    if (stamp !== previous || !exists) {
      const rules = publicAddressRules(config, target, exists);
      execFileSync("nft", ["-c", "-f", "-"], { input: rules, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
      execFileSync("nft", ["-f", "-"], { input: rules, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 });
      previous = stamp;
      console.log(JSON.stringify({ status: target ? "routed" : "inactive", ipAddress: config.ipAddress, podUid: target?.uid }));
    }
    writeFileSync("/run/public-address/state.next", JSON.stringify({ checkedAt: Date.now(), routed: !!target }), { mode: 0o600 });
    renameSync("/run/public-address/state.next", "/run/public-address/state.json");
  };
  // Never fall back to the host's wildcard listeners while awaiting a guest.
  apply();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopped = true; apply(); });
  while (!stopped) {
    let target: PublicAddressTarget | undefined;
    try {
      const assigned = Object.values(networkInterfaces()).flat().some(address => address?.family === "IPv4" && address.address === config.ipAddress);
      if (assigned) target = selectPublicAddressTarget(await listPods(config), config);
    } catch { /* Network/API uncertainty removes only this mapping. Never log API response bodies or tokens. */ }
    apply(stopped ? undefined : target);
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

