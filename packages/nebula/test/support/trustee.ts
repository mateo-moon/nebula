import { generateKeyPairSync } from "node:crypto";
import type { TrusteeConfig, TrusteeSnpIdentity } from "../../src/modules/k8s/trustee";

export const identity = (index = 1): TrusteeSnpIdentity => ({
  measurement: String(index).repeat(96), initDataSha256: String(index + 1).repeat(64),
  chipId: String(index + 2).repeat(128),
  minimumReportedTcb: { bootloader: 3, tee: 1, snp: 12, microcode: 72 },
});

export function trusteeConfig(): TrusteeConfig {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { initDataSha256: _hash, ...guest } = identity();
  return { name: "trustee", namespace: "confidential-keys",
    chart: process.env.TRUSTEE_HELM_CHART ?? "./test/fixtures/unconfigured-trustee-chart",
    kbsImage: `registry.example.test/kbs@sha256:${"a".repeat(64)}`,
    tngImage: `registry.example.test/tng@sha256:${"b".repeat(64)}`,
    ownerPublicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    nodeSelector: { "confidential-computing": "snp" },
    clients: [{ namespace: "workloads", podLabels: { app: "confidential-worker" } }],
    network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
    guest,
  };
}

export const evidence = (guest = identity()): any => ({
  init_data: guest.initDataSha256,
  snp: { measurement: guest.measurement, chip_id: guest.chipId, policy_debug_allowed: false, policy_migrate_ma: false,
    ...Object.fromEntries(Object.entries(guest.minimumReportedTcb).map(([key, value]) => [`reported_tcb_${key}`, value])) },
});
