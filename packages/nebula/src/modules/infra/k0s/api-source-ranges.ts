import { isIP } from "node:net";

/** Validate an explicit API allowlist; an empty list must not silently allow everyone. */
export function apiSourceRanges(ranges?: readonly string[]) {
  if (ranges === undefined) return undefined;
  if (!Array.isArray(ranges) || !ranges.length)
    throw new Error("apiSourceRanges must contain at least one IPv4 or IPv6 CIDR");
  const all = [...new Set(ranges)];
  const ipv4: string[] = [], ipv6: string[] = [];
  for (const range of all) {
    if (typeof range !== "string") throw new Error("apiSourceRanges requires IPv4 or IPv6 CIDRs");
    const parts = range.split("/");
    const family = isIP(parts[0]!);
    if (parts.length !== 2 || !family || parts[0]!.includes("%") || !/^(0|[1-9][0-9]*)$/.test(parts[1]!) ||
      Number(parts[1]) > (family === 4 ? 32 : 128))
      throw new Error("apiSourceRanges requires IPv4 or IPv6 CIDRs");
    (family === 4 ? ipv4 : ipv6).push(range);
  }
  return { all, ipv4, ipv6 };
}
