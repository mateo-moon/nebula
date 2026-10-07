/** Validate the effective Helm values, including the chart's override paths. */
const NETWORK_OPTIONS = new Set([
  "enable-ipv4", "enable-ipv6", "ipam",
  "k8s-require-ipv4-pod-cidr", "k8s-require-ipv6-pod-cidr",
  "routing-mode", "underlay-protocol", "tunnel-protocol", "mtu", "prefer-ipv6",
  "ipv4-node", "ipv6-node", "ipv4-range", "ipv6-range", "ipv6-cluster-alloc-cidr",
  "custom-cni-conf", "read-cni-conf", "write-cni-conf-when-ready",
  "cni-chaining-mode", "cni-chaining-target", "cni-exclusive",
  "config", "config-dir", "config-sources", "config-sources-overrides",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cilium: ${path} must be an object; the selected network configuration cannot be replaced.`);
  }
  return value as Record<string, unknown>;
}

export function validateCiliumNetwork(
  values: Record<string, unknown>,
  connectivity: "public" | "private",
  nodeIpv6ConfigSources?: string,
  podAddressFamilies: "dual-stack" | "ipv4" = "dual-stack",
): void {
  const enableIpv6 = podAddressFamilies === "dual-stack";
  const requireValue = (path: string, expected: unknown) => {
    let actual: unknown = values;
    for (const key of path.split(".")) actual = record(actual, path)[key];
    if (actual !== expected) {
      throw new Error(`Cilium: values.${path} must be ${JSON.stringify(expected)}; the ${podAddressFamilies} profile requires Kubernetes IPAM and the Cilium CNI.`);
    }
  };
  requireValue("ipv4.enabled", true);
  requireValue("ipv6.enabled", enableIpv6);
  requireValue("ipam.mode", "kubernetes");
  requireValue("k8s.requireIPv4PodCIDR", true);
  requireValue("k8s.requireIPv6PodCIDR", enableIpv6);
  requireValue("routingMode", "tunnel");
  requireValue("cni.install", true);
  requireValue("cni.exclusive", true);
  requireValue("cni.customConf", false);
  requireValue("cni.chainingMode", "none");
  requireValue("daemon.configSources", nodeIpv6ConfigSources ?? "config-map:cilium-config");
  if (nodeIpv6ConfigSources) requireValue("daemon.allowedConfigOverrides", "ipv6-node");
  requireValue("agent", true);
  requireValue("sleepAfterInit", false);
  requireValue("rollOutCiliumPods", true);

  const cni = record(values.cni, "values.cni");
  for (const key of ["configMap", "readCniConf", "chainingTarget"]) {
    if (cni[key] !== undefined && cni[key] !== null && cni[key] !== "") {
      throw new Error(`Cilium: values.cni.${key} replaces pod address allocation; custom or chained CNI configurations cannot enforce the selected pod families.`);
    }
  }
  if (values.underlayProtocol !== "ipv4" && values.underlayProtocol !== "ipv6") {
    throw new Error('Cilium: underlayProtocol must be explicitly "ipv4" or "ipv6"; "auto" can silently select unreachable node addresses.');
  }
  if (connectivity === "public" && values.underlayProtocol !== "ipv6") {
    throw new Error('Cilium: public node connectivity requires underlayProtocol "ipv6" and on-link IPv6 node addresses. AWS public IPv4/EIPs are NAT addresses. Use nodeConnectivity "private" only when every node private address is mutually routable.');
  }
  if (connectivity === "public") requireValue("preferIpv6", true);
  if (!enableIpv6) {
    requireValue("underlayProtocol", "ipv4");
    requireValue("preferIpv6", false);
  }
  if (values.tunnelProtocol !== "vxlan" && values.tunnelProtocol !== "geneve") {
    throw new Error('Cilium: tunnelProtocol must be "vxlan" or "geneve".');
  }
  const mtu = values.MTU;
  if (mtu !== undefined && (typeof mtu !== "number" || !Number.isInteger(mtu) || mtu < 1280 || mtu > 65535)) {
    throw new Error("Cilium: MTU must be an integer between 1280 and 65535; a smaller MTU strips IPv6 from cilium_host. Omit MTU for private-network NIC discovery.");
  }
  if (connectivity === "public" && (mtu === undefined || (mtu as number) > 1400)) {
    throw new Error("Cilium: public node connectivity requires an explicit MTU between 1280 and 1400; a jumbo NIC does not describe the internet path.");
  }

  // extraConfig is appended to the ConfigMap (even duplicating existing keys),
  // CLI flags override it, and CILIUM_* environment variables supply options.
  // Reject network settings here rather than relying on Helm merge order.
  if (values.extraConfig !== undefined) {
    for (const key of Object.keys(record(values.extraConfig, "values.extraConfig"))) {
      if (NETWORK_OPTIONS.has(key)) {
        throw new Error(`Cilium: values.extraConfig.${key} bypasses network validation; use the module's network settings.`);
      }
    }
  }
  if (values.extraArgs !== undefined) {
    if (!Array.isArray(values.extraArgs) || values.extraArgs.some(arg => typeof arg !== "string")) {
      throw new Error("Cilium: values.extraArgs must be an array of strings.");
    }
    for (const arg of values.extraArgs as string[]) {
      const option = arg.replace(/^--?/, "").split(/[=\s]/, 1)[0];
      if (NETWORK_OPTIONS.has(option)) {
        throw new Error(`Cilium: values.extraArgs cannot override ${option}; use the module's network settings.`);
      }
    }
  }
  if (values.extraEnv !== undefined) {
    if (!Array.isArray(values.extraEnv)) throw new Error("Cilium: values.extraEnv must be an array.");
    for (const env of values.extraEnv) {
      const name = record(env, "values.extraEnv[]").name;
      if (typeof name !== "string") throw new Error("Cilium: each values.extraEnv entry must have a name.");
      const option = name.replace(/^CILIUM_/, "").toLowerCase().replaceAll("_", "-");
      if (name.startsWith("CILIUM_") && NETWORK_OPTIONS.has(option)) {
        throw new Error(`Cilium: values.extraEnv cannot override ${name}; use the module's network settings.`);
      }
    }
  }
}
