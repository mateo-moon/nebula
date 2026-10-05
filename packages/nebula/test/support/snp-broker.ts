import type { AttestedPullBrokerProps, SnpBrokerAdmission } from "../../src/modules/k8s/confidential-guests";

// Synthetic test values only; not recommended hardware or deployment floors.
export const snpAdmission: SnpBrokerAdmission = {
  minimumReportedTcb: { bootloader: 3, tee: 1, snp: 8, microcode: 42 },
};
export const initData = { form: "equals", value: "ab".repeat(32) } as const;
export const measurement = { form: "equals", value: "cd".repeat(48) } as const;
export const resourcePath = ["default", "registry", "pull"] as const;
export const configToml = `[http_server]
insecure_http = true
sockets = ["0.0.0.0:8080"]
[attestation_token]
insecure_header_jwk = false
trusted_certs_paths = ["/state/issuer/cert.pem"]
[attestation_service]
type = "coco_as_builtin"
[attestation_service.attestation_token_broker]
duration_min = 5
[attestation_service.attestation_token_broker.signer]
key_path = "/state/issuer/key.pem"
cert_path = "/state/issuer/cert.pem"
[admin]
authorization_mode = "DenyAll"
[storage_backend]
storage_type = "LocalFs"
[storage_backend.backends.local_fs]
dir_path = "/state"
[[plugins]]
name = "resource"
storage_backend_type = "kvstorage"
`;

export const snpBrokerProps = (change: Partial<AttestedPullBrokerProps> = {}): AttestedPullBrokerProps => ({
  namespace: "guests", name: "pull-broker", configMapName: "pull-broker-configuration",
  networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
  podLabels: { app: "pull-broker" }, guestSelector: { app: "guest" }, nodeName: "guest-host-1",
  brokerImage: `registry.example.com/guests/kbs@sha256:${"ef".repeat(32)}`,
  issuer: "ephemeral", configToml, resourcePath, initData, measurement, snpAdmission,
  pullSecret: { name: "registry-pull", exposeAsResource: true }, labelDomain: "guests.example.com", ...change,
});

export const snpEvidence = () => ({
  init_data: initData.value,
  snp: {
    measurement: measurement.value, policy_debug_allowed: false, policy_migrate_ma: false,
    reported_tcb_bootloader: 3, reported_tcb_tee: 1, reported_tcb_snp: 8, reported_tcb_microcode: 42,
  },
});
