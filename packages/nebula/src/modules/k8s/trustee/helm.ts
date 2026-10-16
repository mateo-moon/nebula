import { Helm, JsonPatch, type ApiObject, type HelmProps } from "cdk8s";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { canonicalJson } from "../confidential-guests/canonical";
import { INIT_DATA_ANNOTATION } from "../confidential-guests/measured";
import { measuredFragments } from "../envoy";
import type { TrusteeContainer, TrusteeDeploymentManifest, TrusteePodManifest } from "./manifests";
import type { TrusteeConfig } from "./types";

type ReleaseConfig = Pick<TrusteeConfig, "name" | "namespace" | "nodeSelector">;

/** Values for the official chart's self-contained KBS mode. Secrets and mutable
 * ConfigMaps cannot cross the guest boundary; public startup input is measured. */
export function confidentialTrusteeValues(config: ReleaseConfig, guest: {
  image: string; script: string; restApi: "attestation" | "resource"; port: number; memory: number; vcpus: number;
}) {
  const [repository, digest] = guest.image.split("@");
  const probe = { tcpSocket: { port: guest.port }, periodSeconds: 10 };
  return {
    fullnameOverride: config.name, log_level: "off", sessionStorageType: "Memory",
    storageBackend: { type: "Memory" }, as: { enabled: false }, rvps: { enabled: false },
    secrets: { enabled: false }, postgresql: { enabled: false }, valkey: { enabled: false },
    ingress: { enabled: false }, nodePort: { enabled: false },
    kbs: {
      managedConfig: false, replicaCount: 1, strategy: { type: "Recreate" },
      runtimeClassName: "kata-qemu-snp", enableServiceLinks: false,
      image: { repository, digest, pullPolicy: "Always" },
      command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', "trustee"],
      args: measuredFragments(Buffer.from(guest.script).toString("base64")),
      extraEnvVars: [{ name: "RUST_BACKTRACE", value: "0" }, { name: "HOME", value: "/tmp" }],
      podAnnotations: {
        "io.containerd.cri.runtime-handler": "kata-qemu-snp",
        "io.katacontainers.config.hypervisor.default_memory": String(guest.memory),
        "io.katacontainers.config.hypervisor.default_vcpus": String(guest.vcpus),
        "io.katacontainers.config.hypervisor.kernel_params":
          `agent.guest_components_procs=api-server-rest agent.guest_components_rest_api=${guest.restApi}`,
      },
      podSecurityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true, fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" } },
      containerSecurityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] } },
      nodeSelector: { ...config.nodeSelector },
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } },
      containerPort: guest.port, service: { port: guest.port, targetPort: "http", exposeLoadBalancer: false },
      probes: { enabled: true, readiness: probe, liveness: probe },
      extraVolumes: [] as { name: string; emptyDir: { medium: string; sizeLimit: string } }[],
      extraVolumeMounts: [] as { name: string; mountPath: string }[],
      extraContainers: [] as TrusteeContainer[],
    },
  };
}

type TrusteeValues = ReturnType<typeof confidentialTrusteeValues>;

export function trusteeHelmProps(config: ReleaseConfig, values: TrusteeValues): HelmProps {
  if (config.name.length > 53) throw new TypeError("Trustee: Helm release name must not exceed 53 characters");
  return { chart: dirname(fileURLToPath(new URL("./assets/helm/trustee/Chart.yaml", import.meta.url))),
    releaseName: config.name, namespace: config.namespace, values };
}

/** Generation and deployment use the same Helm output. Never
 * rebuild a parallel Pod spec that can drift from what the chart deploys. */
export function readTrusteeHelmPlan(helm: Helm, config: ReleaseConfig, values: TrusteeValues) {
  const objects = helm.apiObjects;
  const deployment = objects.find(object => object.kind === "Deployment");
  const service = objects.find(object => object.kind === "Service");
  const fail = (): never => { throw new TypeError("Trustee: chart must support self-contained KBS without host configuration, keys or extra workloads"); };
  if (objects.length !== 2 || !deployment || !service) fail();
  // Helm normally assigns the release namespace at install time. cdk8s emits
  // manifests for Kubernetes/GitOps, so make that namespace explicit.
  for (const object of objects) object.addJsonPatch(JsonPatch.add("/metadata/namespace", config.namespace));
  const workload = deployment!.toJson() as TrusteeDeploymentManifest;
  const spec = workload.spec.template.spec;
  // Check the contract before binding a policy. In particular an unextended
  // official chart must fail, instead of silently ignoring security values.
  const raw = spec as unknown as Record<string, unknown>;
  if (spec.runtimeClassName !== "kata-qemu-snp" || spec.automountServiceAccountToken !== false ||
      spec.enableServiceLinks !== false || raw.hostNetwork || raw.hostPID || raw.hostIPC ||
      raw.initContainers || raw.ephemeralContainers || workload.spec.replicas !== 1 ||
      workload.spec.strategy?.type !== "Recreate" || spec.securityContext?.runAsUser !== 10001 ||
      spec.securityContext?.runAsNonRoot !== true ||
      spec.containers.length !== 1 + values.kbs.extraContainers.length ||
      !spec.volumes?.length || spec.volumes.some(volume => Object.keys(volume).sort().join() !== "emptyDir,name" ||
        volume.emptyDir?.medium !== "Memory")) fail();
  const kbs = spec.containers[0];
  if (kbs.name !== "kbs" || kbs.image !== `${values.kbs.image.repository}@${values.kbs.image.digest}` ||
      canonicalJson(kbs.command) !== canonicalJson(values.kbs.command) ||
      canonicalJson(kbs.args) !== canonicalJson(values.kbs.args)) fail();
  for (const container of spec.containers) {
    if (container.securityContext?.allowPrivilegeEscalation !== false ||
        container.securityContext.readOnlyRootFilesystem !== true ||
        container.securityContext.privileged ||
        canonicalJson(container.securityContext.capabilities?.drop) !== '["ALL"]' ||
        container.env?.some(variable => variable.valueFrom || typeof variable.value !== "string") || "envFrom" in container) fail();
  }
  for (const expected of values.kbs.extraContainers) {
    const actual = spec.containers.find(container => container.name === expected.name);
    if (canonicalJson(actual) !== canonicalJson(expected)) fail();
  }
  const svc = service!.toJson();
  if (svc.spec.type !== "ClusterIP" || svc.spec.ports.length !== 1 ||
      svc.spec.ports[0].port !== values.kbs.service.port || svc.spec.ports[0].targetPort !== values.kbs.service.targetPort ||
      canonicalJson(svc.spec.selector) !== canonicalJson(workload.spec.selector.matchLabels)) fail();
  const pod: TrusteePodManifest = { apiVersion: "v1", kind: "Pod", metadata: {
    name: workload.metadata.name, namespace: config.namespace, ...workload.spec.template.metadata,
  }, spec };
  return { pod, workload };
}

/** Add the native annotation without replacing Helm's manifests. */
export function annotateTrustee(deployment: ApiObject, ccInitData: string): void {
  deployment.addJsonPatch(JsonPatch.add(`/spec/template/metadata/annotations/${INIT_DATA_ANNOTATION.replaceAll("/", "~1")}`,
    ccInitData));
}
