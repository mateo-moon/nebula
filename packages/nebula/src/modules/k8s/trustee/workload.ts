import { measuredFragments } from "../envoy";
import { tngTrusteeClientPlan } from "./client-plan";
import type { TrusteeSnpIdentity } from "./policies";
export { generateAttestedWorkloadPolicy } from "./genpolicy";

const encode = (value: string) => Buffer.from(value).toString("base64");
const write = (path: string, value: string) => `printf '%s' '${encode(value)}' | base64 -d > ${path}`;

/** Public bootstrap containers for native CoCo image pulls. Both are persistent
 * init sidecars in the SAME PodVM as the encrypted workload. The AA/CDH KBC must
 * point to 127.0.0.1:18080, and native genpolicy must measure these declarations.
 * The host supplies neither the verification policy nor verifier signing keys. */
export function trusteeClientSidecars(options: {
  identity: TrusteeSnpIdentity;
  target: { host: string; port: number };
  verifierImage: string;
  tngImage: string;
}) {
  for (const image of [options.verifierImage, options.tngImage]) {
    if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new TypeError("Trustee client images must be digest-pinned");
  }
  const plan = tngTrusteeClientPlan(options.identity, options.target);
  // Kubelet gates restartable init sidecars with a TCP startup probe. Exposing
  // this verified transport does not expose the AS control API (loopback only),
  // and native KBS recipient attestation still protects every released key.
  plan.tngConfig.add_ingress[0].mapping.in.host = "0.0.0.0";
  const verifierScript = [
    "set -eu", "umask 077", "cd /state", "mkdir -p storage/attestation_service_policy",
    write("as.json", JSON.stringify(plan.asConfig)),
    write("storage/attestation_service_policy/approved_cpu.rego", plan.policy),
    "openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null",
    "openssl req -new -x509 -key ca.key -sha256 -days 365 -subj /CN=mev-verifier-ca -addext basicConstraints=critical,CA:TRUE,pathlen:0 -addext keyUsage=critical,keyCertSign -out ca.pending.pem 2>/dev/null",
    "openssl ecparam -name prime256v1 -genkey -noout -out signer.key 2>/dev/null",
    "openssl req -new -key signer.key -subj /CN=mev-verifier -out signer.csr 2>/dev/null",
    write("signer.ext", "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n"),
    "openssl x509 -req -in signer.csr -CA ca.pending.pem -CAkey ca.key -CAcreateserial -sha256 -days 365 -extfile signer.ext -out signer.pem 2>/dev/null",
    "rm -f ca.key ca.pending.srl signer.csr signer.ext",
    "mv ca.pending.pem ca.pem",
    "exec /usr/local/bin/restful-as --socket 127.0.0.1:18082 --config-file /state/as.json",
  ].join("\n");
  const tngScript = [
    "set -eu", "umask 077",
    write("/tmp/tng.json", JSON.stringify(plan.tngConfig)),
    "until test -s /state/ca.pem; do sleep 1; done",
    "until curl --silent --output /dev/null --max-time 2 http://127.0.0.1:18082/; do sleep 1; done",
    "exec tng launch --config-file /tmp/tng.json",
  ].join("\n");
  const container = (name: string, image: string, script: string, readOnly: boolean) => ({
    name, image, imagePullPolicy: "Always", restartPolicy: "Always",
    command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', name],
    args: measuredFragments(encode(script)),
    env: [{ name: "RUST_LOG", value: "error" }, { name: "RUST_BACKTRACE", value: "0" }, { name: "HOME", value: "/tmp" }],
    securityContext: { runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
    volumeMounts: [{ name: "trustee-verifier-state", mountPath: "/state", ...(readOnly ? { readOnly: true } : {}) },
      { name: `${name}-tmp`, mountPath: "/tmp" },
      // Override the upstream image's VOLUME declaration. Otherwise containerd
      // creates a host directory and Kata correctly refuses to copy it in.
      ...(name === "trustee-verifier" ? [{ name: "trustee-verifier-cache", mountPath: "/opt/confidential-containers/attestation-service" }] : [])],
    resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "256Mi" } },
  });
  return {
    initContainers: [container("trustee-verifier", options.verifierImage, verifierScript, false),
      { ...container("trustee-client", options.tngImage, tngScript, true),
        ports: [{ name: "kbs-client", containerPort: 18080 }],
        startupProbe: { tcpSocket: { port: 18080 }, periodSeconds: 2, failureThreshold: 60 },
      }],
    volumes: ["trustee-verifier-state", "trustee-verifier-tmp", "trustee-verifier-cache", "trustee-client-tmp"].map(name => ({
      name, emptyDir: { medium: "Memory", sizeLimit: "64Mi" },
    })),
    kbsUrl: "http://127.0.0.1:18080",
  };
}
