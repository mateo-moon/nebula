import { isIP } from "node:net";

export type CiliumIpamConfig = { mode: "kubernetes" } | {
  mode: "cluster-pool";
  /** Ordered cluster-wide pools. Existing entries must not be edited or removed. */
  ipv4PodCidrs: readonly string[];
  ipv6PodCidrs?: readonly string[];
};

function poolRange(value: string, family: 4 | 6): [bigint, bigint] {
  const [address, text, extra] = value.split("/");
  const nodeMask = family === 4 ? 24 : 64;
  if (isIP(address) !== family || address.includes("%") || (family === 6 && address.includes(".")) ||
      extra !== undefined || !/^(?:0|[1-9][0-9]*)$/.test(text ?? "")) {
    throw new Error(`Cilium: cluster-pool requires canonical IPv${family} CIDRs`);
  }
  const prefix = Number(text);
  // Bound bitmap allocation to 16 subdivision bits, also the IPv6 backend
  // limit. Per-node masks retain the /24 IPv4 and /64 IPv6 contract.
  if (prefix > nodeMask || nodeMask - prefix > 16) {
    throw new Error(`Cilium: IPv${family} pool prefix must be between /${nodeMask - 16} and /${nodeMask}`);
  }
  let number: bigint;
  if (family === 4) {
    number = address.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n);
  } else {
    const [left, right] = address.split("::");
    const a = left ? left.split(":") : [];
    const b = right ? right.split(":") : [];
    const parts = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
    number = parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
  }
  const size = 1n << BigInt((family === 4 ? 32 : 128) - prefix);
  if (number % size !== 0n) throw new Error(`Cilium: pool ${value} has host bits set`);
  return [number, number + size - 1n];
}

export function ciliumIpamValues(config: CiliumIpamConfig | undefined, ipv6: boolean): Record<string, unknown> {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new Error("Cilium: ipam must select kubernetes or cluster-pool");
  }
  if (config === undefined || config.mode === "kubernetes") {
    return { ipam: { mode: "kubernetes" }, k8s: { requireIPv4PodCIDR: true, requireIPv6PodCIDR: ipv6 } };
  }
  if (config.mode !== "cluster-pool") throw new Error("Cilium: ipam.mode must be kubernetes or cluster-pool");
  for (const [family, pools] of [[4, config.ipv4PodCidrs], [6, config.ipv6PodCidrs]] as const) {
    if (family === 6 && !ipv6) {
      if (pools !== undefined) throw new Error("Cilium: IPv4-only cluster-pool cannot declare IPv6 pools");
      continue;
    }
    if (!Array.isArray(pools) || pools.length === 0 || pools.some(pool => typeof pool !== "string")) {
      throw new Error(`Cilium: cluster-pool requires explicit nonempty IPv${family} pools`);
    }
    const ranges = pools.map(pool => poolRange(pool, family));
    for (let i = 0; i < ranges.length; i++) for (let j = 0; j < i; j++) {
      if (ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1]) {
        throw new Error(`Cilium: IPv${family} cluster pools must not overlap`);
      }
    }
  }
  return {
    ipam: { mode: "cluster-pool", operator: {
      clusterPoolIPv4PodCIDRList: [...config.ipv4PodCidrs], clusterPoolIPv4MaskSize: 24,
      ...(ipv6 ? { clusterPoolIPv6PodCIDRList: [...config.ipv6PodCidrs!], clusterPoolIPv6MaskSize: 64 } : {}),
    } },
    // Pool allocation comes from CiliumNode, independently of Node.spec.podCIDRs.
    k8s: { requireIPv4PodCIDR: false, requireIPv6PodCIDR: false },
  };
}
