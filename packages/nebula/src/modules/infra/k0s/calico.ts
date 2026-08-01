/**
 * k0s-bundled Calico configuration (`spec.network.calico`).
 *
 * One definition shared by every k0s cluster construct — the standalone-CP
 * `K0sCluster`, the hosted-CP `K0smotronCluster`/`K0smotronControlPlane`, the
 * legacy `AwsK0sCluster`, and the AWS provider's security-group derivation.
 * Previously this type was inlined at six call sites and the defaults block
 * copy-pasted at four, so widening the surface meant editing all of them.
 *
 * This is the CNI k0s installs itself, via the manifest applier. It is NOT the
 * tigera-operator (`modules/k8s/calico`) — see that module's header for when
 * each applies. The provider is immutable after cluster creation.
 */

/** k0s `spec.network.calico`. Every field optional; unset means k0s's default. */
export interface K0sCalicoConfig {
  /** Transport backend. Default "vxlan". */
  mode?: "vxlan" | "ipip" | "bird";
  /** Overlay scope. Ignored by k0s in vxlan mode. */
  overlay?: "Always" | "CrossSubnet" | "Never";
  /** WireGuard encryption for node-to-node pod traffic. Default true. */
  wireguard?: boolean;
  /** Overlay MTU. k0s binds this to VXLAN, IP-in-IP AND WireGuard together. */
  mtu?: number;
  /** VXLAN UDP port. Default 4789. */
  vxlanPort?: number;
  /** VXLAN VNI. Default 4096. */
  vxlanVni?: number;
  /**
   * Calico `IP_AUTODETECTION_METHOD` — how each node picks its tunnel endpoint
   * address: "first-found" | "kubernetes-internal-ip" | "can-reach=<ip>" |
   * "interface=<regex>" | "skip-interface=<regex>" | "cidr=<cidr>,...".
   * Unset means Calico's first-found, which on a node with several interfaces
   * can select an address peers cannot reach.
   */
  ipAutodetectionMethod?: string;
  /** IPv6 equivalent. k0s falls back to `ipAutodetectionMethod` when unset. */
  ipV6AutodetectionMethod?: string;
  /**
   * Extra calico-node env vars. Felix reads env vars ABOVE every
   * FelixConfiguration tier, so this is the escape hatch for any Felix setting
   * k0s does not expose (e.g. FELIX_VXLANMTU / FELIX_WIREGUARDMTU separately).
   */
  envVars?: Record<string, string>;
  /** Host path for the flex-volume driver. */
  flexVolumeDriverPath?: string;
  /**
   * Pin the bundled Calico image version (k0s `spec.images.calico`, the
   * k0sproject builds on quay.io) — e.g. "v3.31.5-0" for the wg6
   * tunnel-address allocation fix (calico#10599, fixed upstream v3.31.0).
   * Renders OUTSIDE network.calico (a ClusterConfig-spec sibling), so the
   * constructs emit it via {@link renderK0sCalicoImages}. CAUTION: on a
   * standalone K0sControlPlane any k0sConfigSpec change ROLLS the CP
   * machines; on a hosted CP it only restarts the CP pod.
   */
  imageVersion?: string;
}

/**
 * Calico config with the values needed outside the k0s ClusterConfig resolved.
 * `mode`/`wireguard`/`vxlanPort` also drive the AWS provider's CNI ingress
 * rules, so they must be resolved once and shared — otherwise a caller relying
 * on a default gets a security group that does not match the transport actually
 * in use (which silently drops all cross-node pod traffic).
 */
export interface ResolvedK0sCalico {
  /** The caller's config verbatim; the renderer emits only what was set. */
  readonly config: K0sCalicoConfig;
  readonly mode: "vxlan" | "ipip" | "bird";
  readonly wireguard: boolean;
  readonly vxlanPort: number;
}

export function resolveK0sCalico(config: K0sCalicoConfig = {}): ResolvedK0sCalico {
  return {
    config,
    mode: config.mode ?? "vxlan",
    wireguard: config.wireguard ?? true,
    vxlanPort: config.vxlanPort ?? 4789,
  };
}

/**
 * Render `spec.network.calico` for the embedded k0s ClusterConfig.
 *
 * Emits k0s's own key spelling — `vxlanVNI` and `ipV6AutodetectionMethod` are
 * NOT the TS property names, and k0s ignores unknown keys silently, so a
 * camelCased key would be a no-op that looks applied.
 *
 * Only `mode` and `wireguard` are emitted unconditionally; everything else
 * appears only when the caller set it. `vxlanPort` in particular is resolved
 * for the SG rules but left out of the render, so an existing cluster's
 * k0sConfigSpec does not change (which would roll its control plane).
 */
export function renderK0sCalicoSpec(c: ResolvedK0sCalico): Record<string, unknown> {
  const s = c.config;
  return {
    mode: c.mode,
    wireguard: c.wireguard,
    ...(s.mtu ? { mtu: s.mtu } : {}),
    ...(s.overlay ? { overlay: s.overlay } : {}),
    ...(s.vxlanPort ? { vxlanPort: s.vxlanPort } : {}),
    ...(s.vxlanVni ? { vxlanVNI: s.vxlanVni } : {}),
    ...(s.ipAutodetectionMethod
      ? { ipAutodetectionMethod: s.ipAutodetectionMethod }
      : {}),
    ...(s.ipV6AutodetectionMethod
      ? { ipV6AutodetectionMethod: s.ipV6AutodetectionMethod }
      : {}),
    ...(s.envVars ? { envVars: s.envVars } : {}),
    ...(s.flexVolumeDriverPath
      ? { flexVolumeDriverPath: s.flexVolumeDriverPath }
      : {}),
  };
}

/**
 * Render the `spec.images` fragment for a Calico image pin (empty object when
 * unset — spreads to nothing, leaving existing clusters' k0sConfigSpec
 * byte-identical). The k0sproject builds keep k0s's bundled-manifest
 * compatibility exactly; all three repos publish the same tag.
 */
export function renderK0sCalicoImages(
  c: ResolvedK0sCalico,
): Record<string, unknown> {
  const v = c.config.imageVersion;
  if (!v) return {};
  return {
    images: {
      calico: {
        cni: { image: "quay.io/k0sproject/calico-cni", version: v },
        node: { image: "quay.io/k0sproject/calico-node", version: v },
        kubecontrollers: {
          image: "quay.io/k0sproject/calico-kube-controllers",
          version: v,
        },
      },
    },
  };
}
