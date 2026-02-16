/**
 * WireGuardMesh - Point-to-point WireGuard tunnels for cross-site node connectivity.
 *
 * Deploys a DaemonSet that creates WireGuard interfaces on selected nodes,
 * enabling pod CIDR and service routing across different networks (e.g.,
 * Hetzner bare metal + GCP VMs in a single cluster).
 *
 * @example
 * ```typescript
 * import { WireGuardMesh } from 'nebula/modules/k8s/wireguard-mesh';
 *
 * new WireGuardMesh(chart, 'wireguard', {
 *   peers: [
 *     {
 *       name: 'site-a',
 *       nodeSelector: { 'kubernetes.io/hostname': 'node-a' },
 *       publicKey: 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC=',
 *       endpoint: '203.0.113.1:51820',
 *       address: '10.99.0.1/24',
 *       allowedIPs: ['10.99.0.1/32', '10.244.0.0/24'],
 *     },
 *     {
 *       name: 'site-b',
 *       nodeSelector: { 'kubernetes.io/hostname': 'node-b' },
 *       publicKey: 'xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=',
 *       address: '10.99.0.2/24',
 *       allowedIPs: ['10.99.0.2/32', '10.244.2.0/24'],
 *     },
 *   ],
 *   privateKeys: {
 *     'site-a': 'ref+sops://secrets.yaml#wireguard/site_a_key',
 *     'site-b': 'ref+sops://secrets.yaml#wireguard/site_b_key',
 *   },
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { BaseConstruct } from "../../../core";

/** A peer node in the WireGuard mesh */
export interface WireGuardPeer {
  /** Unique name for this peer (must match a key in privateKeys) */
  name: string;
  /** Node selector to target this peer's K8s node */
  nodeSelector: Record<string, string>;
  /** WireGuard public key */
  publicKey: string;
  /** Static endpoint (host:port) — omit for peers with ephemeral IPs */
  endpoint?: string;
  /** WireGuard tunnel IP with CIDR (e.g., "10.99.0.1/24") */
  address: string;
  /** CIDRs to route through this peer (tunnel IP + pod CIDR) */
  allowedIPs: string[];
}

export interface WireGuardMeshConfig {
  /** Namespace for WireGuard resources (defaults to "wireguard-system") */
  namespace?: string;
  /** WireGuard listen port (defaults to 51820) */
  listenPort?: number;
  /** WireGuard interface name (defaults to "wg0") */
  interfaceName?: string;
  /** Mesh peers — one entry per node */
  peers: WireGuardPeer[];
  /** Private keys keyed by peer name (supports ref+sops:// for decryption) */
  privateKeys: Record<string, string>;
  /** PersistentKeepalive interval in seconds for peers without static endpoints (defaults to 25) */
  keepalive?: number;
  /** WireGuard interface MTU (defaults to 1420) */
  mtu?: number;
}

export class WireGuardMesh extends BaseConstruct<WireGuardMeshConfig> {
  constructor(scope: Construct, id: string, config: WireGuardMeshConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "wireguard-system";
    const listenPort = this.config.listenPort ?? 51820;
    const ifName = this.config.interfaceName ?? "wg0";
    const keepalive = this.config.keepalive ?? 25;
    const mtu = this.config.mtu ?? 1420;
    const peers = this.config.peers;

    // --- Namespace ---

    new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // --- Secret (private keys) ---

    const secretName = "wireguard-keys";
    new kplus.Secret(this, "keys", {
      metadata: { name: secretName, namespace: namespaceName },
      stringData: this.config.privateKeys,
    });

    // --- ConfigMap (per-peer WireGuard configs) ---

    // Generate a wg-quick config for each peer. Each peer's config contains
    // its own [Interface] section and [Peer] sections for all OTHER peers.
    const configData: Record<string, string> = {};
    for (const self of peers) {
      const otherPeers = peers.filter((p) => p.name !== self.name);
      const peerSections = otherPeers
        .map((p) => {
          const lines = [
            "[Peer]",
            `PublicKey = ${p.publicKey}`,
            `AllowedIPs = ${p.allowedIPs.join(", ")}`,
          ];
          if (p.endpoint) {
            lines.push(`Endpoint = ${p.endpoint}`);
          }
          // Peers without a static endpoint need keepalive to maintain NAT mappings
          // and to allow the other side to discover their ephemeral IP
          if (!self.endpoint) {
            lines.push(`PersistentKeepalive = ${keepalive}`);
          }
          return lines.join("\n");
        })
        .join("\n\n");

      configData[`${self.name}.conf`] = [
        "[Interface]",
        `Address = ${self.address}`,
        `ListenPort = ${listenPort}`,
        `MTU = ${mtu}`,
        `PrivateKey = __PRIVATE_KEY__`,
        "",
        peerSections,
      ].join("\n");
    }

    const configMapName = "wireguard-config";
    new kplus.ConfigMap(this, "config", {
      metadata: { name: configMapName, namespace: namespaceName },
      data: configData,
    });

    // --- DaemonSet ---

    // Build node affinity to run only on nodes matching any peer's nodeSelector
    const nodeSelectorTerms = peers.map((p) => ({
      matchExpressions: Object.entries(p.nodeSelector).map(([key, value]) => ({
        key,
        operator: "In",
        values: [value],
      })),
    }));

    // Build the peer-name lookup table. Each line has patterns (pipe-separated)
    // that are matched as substrings against NODE_NAME. Patterns include:
    // the peer name itself and all nodeSelector values.
    const peerLookup = peers
      .map((p) => {
        const patterns = [
          p.name,
          ...Object.values(p.nodeSelector),
          ...Object.keys(p.nodeSelector)
            .filter((k) => k.includes("/"))
            .map((k) => k.split("/").pop()),
        ];
        return `${patterns.join(",")}|${p.name}`;
      })
      .join("\n");

    // Init container script: load module, install tools, bring up interface
    const initScript = [
      "set -e",
      "",
      "# Load WireGuard kernel module",
      "modprobe wireguard",
      "",
      "# Install wireguard-tools (pulls iproute2 as dependency)",
      "apk add --no-cache wireguard-tools >/dev/null 2>&1",
      "",
      "# Clean up stale interface from previous run (wg-quick fails if it exists)",
      `ip link del ${ifName} 2>/dev/null || true`,
      "",
      "# Match NODE_NAME to a peer config. Try peer name and nodeSelector values as substrings.",
      `PEER_LOOKUP="${peerLookup}"`,
      'PEER_NAME=""',
      'echo "$PEER_LOOKUP" | while IFS="|" read -r patterns name; do',
      '  echo "$patterns" | tr "," "\\n" | while read -r pat; do',
      '    case "$NODE_NAME" in',
      '      *"$pat"*) echo "$name" > /tmp/peer_match; break 2 ;;',
      "    esac",
      "  done",
      "done",
      "[ -f /tmp/peer_match ] && PEER_NAME=$(cat /tmp/peer_match)",
      "",
      'if [ -z "$PEER_NAME" ] || [ ! -f "/etc/wireguard-peers/${PEER_NAME}.conf" ]; then',
      '  echo "ERROR: No WireGuard config for node $NODE_NAME (peer: $PEER_NAME)"',
      '  echo "Available: $(ls /etc/wireguard-peers/)"',
      "  exit 1",
      "fi",
      "",
      'echo "Configuring WireGuard for peer $PEER_NAME on node $NODE_NAME"',
      "",
      "# Inject private key into config and write to runtime dir",
      'PRIVATE_KEY=$(cat "/etc/wireguard-keys/${PEER_NAME}")',
      `mkdir -p /etc/wireguard`,
      `cp "/etc/wireguard-peers/\${PEER_NAME}.conf" "/etc/wireguard/${ifName}.conf"`,
      `sed -i "s|__PRIVATE_KEY__|$PRIVATE_KEY|" "/etc/wireguard/${ifName}.conf"`,
      "",
      "# Add host routes for peer endpoints that overlap with allowedIPs.",
      "# Without this, wg-quick routes endpoint traffic into the tunnel itself (routing loop).",
      `DEFAULT_GW=$(ip -4 route show default | awk '{print $3; exit}')`,
      `DEFAULT_DEV=$(ip -4 route show default | awk '{print $5; exit}')`,
      `for ep in $(grep '^Endpoint' "/etc/wireguard/${ifName}.conf" | sed 's/.*= *//;s/:.*//'); do`,
      `  if grep -q "AllowedIPs.*$ep" "/etc/wireguard/${ifName}.conf"; then`,
      `    echo "Adding host route for endpoint $ep via $DEFAULT_GW dev $DEFAULT_DEV"`,
      `    ip route add "$ep/32" via "$DEFAULT_GW" dev "$DEFAULT_DEV" 2>/dev/null || true`,
      "  fi",
      "done",
      "",
      "# Bring up the interface",
      `wg-quick up /etc/wireguard/${ifName}.conf`,
      `echo "WireGuard interface ${ifName} is up"`,
      "wg show",
    ].join("\n");

    new ApiObject(this, "daemonset", {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: "wireguard", namespace: namespaceName },
      spec: {
        selector: {
          matchLabels: { app: "wireguard" },
        },
        template: {
          metadata: {
            labels: { app: "wireguard" },
          },
          spec: {
            hostNetwork: true,
            tolerations: [
              { operator: "Exists", effect: "NoSchedule" },
              { operator: "Exists", effect: "NoExecute" },
            ],
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms,
                },
              },
            },
            initContainers: [
              {
                name: "setup",
                image: "alpine:3.21",
                command: ["/bin/sh", "-c"],
                args: [initScript],
                securityContext: {
                  privileged: true,
                  capabilities: {
                    add: ["NET_ADMIN", "SYS_MODULE"],
                  },
                },
                env: [
                  {
                    name: "NODE_NAME",
                    valueFrom: {
                      fieldRef: { fieldPath: "spec.nodeName" },
                    },
                  },
                ],
                volumeMounts: [
                  {
                    name: "wireguard-config",
                    mountPath: "/etc/wireguard-peers",
                    readOnly: true,
                  },
                  {
                    name: "wireguard-keys",
                    mountPath: "/etc/wireguard-keys",
                    readOnly: true,
                  },
                  {
                    name: "host-modules",
                    mountPath: "/lib/modules",
                    readOnly: true,
                  },
                ],
              },
            ],
            containers: [
              {
                name: "keepalive",
                image: "alpine:3.21",
                command: ["/bin/sh", "-c"],
                args: ["sleep infinity"],
                securityContext: {
                  privileged: true,
                  capabilities: {
                    add: ["NET_ADMIN"],
                  },
                },
                lifecycle: {
                  preStop: {
                    exec: {
                      command: [
                        "/bin/sh",
                        "-c",
                        `ip link del ${ifName} 2>/dev/null || true`,
                      ],
                    },
                  },
                },
              },
            ],
            volumes: [
              {
                name: "wireguard-config",
                configMap: { name: configMapName },
              },
              {
                name: "wireguard-keys",
                secret: { secretName },
              },
              {
                name: "host-modules",
                hostPath: { path: "/lib/modules", type: "Directory" },
              },
            ],
          },
        },
      },
    });
  }
}
