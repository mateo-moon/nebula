import { Helm, JsonPatch, type ApiObject, type HelmProps } from "cdk8s";
import { canonicalJson } from "../confidential-guests/canonical";
import { INIT_DATA_ANNOTATION } from "../confidential-guests/measured";
import { measuredFragments } from "../envoy";
import type { TrusteeContainer, TrusteeDeploymentManifest, TrusteePodManifest } from "./manifests";
import type { TrusteeConfig } from "./types";

type ReleaseConfig = Pick<TrusteeConfig, "name" | "namespace" | "nodeSelector">;

/** Upstream-supported values and the small set of missing confidential-mode
 * extensions are separate. Never rely on Helm silently ignoring unknown values. */
export function confidentialTrusteeHelmSettings(config: ReleaseConfig, guest: {
  image: string; script: string; restApi: "attestation" | "resource"; port: number; memory: number; vcpus: number;
}) {
  return {
    values: {
      fullnameOverride: config.name, log_level: "error", sessionStorageType: "Memory",
      storageBackend: { type: "Memory" },
      // Suppress upstream key-generation hooks. The unused Secret reference is
      // removed from the rendered Pod before policy generation or synthesis.
      secrets: { useEphemeralGeneratedKeys: false, existingSecretName: "unused-guest-generated-keys" },
      postgresql: { enabled: false }, valkey: { enabled: false },
      ingress: { enabled: false }, nodePort: { enabled: false },
      kbs: {
        replicaCount: 1,
        image: { repository: guest.image.split("@")[0], tag: "unused", pullPolicy: "Always" },
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
        nodeSelector: { ...config.nodeSelector },
        resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } },
        service: { port: guest.port, exposeLoadBalancer: false },
      },
    },
    extensions: {
      image: guest.image,
      command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', "trustee"],
      args: measuredFragments(Buffer.from(guest.script).toString("base64")),
      containerSecurityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] } },
      volumes: [] as { name: string; emptyDir: { medium: string; sizeLimit: string } }[],
      volumeMounts: [] as { name: string; mountPath: string }[],
      extraContainers: [] as TrusteeContainer[],
    },
  };
}

export type TrusteeHelmSettings = ReturnType<typeof confidentialTrusteeHelmSettings>;

export function trusteeHelmProps(config: ReleaseConfig, settings: TrusteeHelmSettings, chart: string): HelmProps {
  if (config.name.length > 53) throw new TypeError("Trustee: Helm release name must not exceed 53 characters");
  return { chart, releaseName: config.name, namespace: config.namespace, values: settings.values,
    // Built-in AS/RVPS run inside KBS. Select only the upstream KBS resources;
    // never synthesize separate services, ConfigMaps, keys, RBAC or bootstrap Jobs.
    helmFlags: ["--show-only", "templates/kbs-deployment.yaml", "--show-only", "templates/kbs-service.yaml"] };
}

/** Extend actual Helm resources, as other Nebula modules do. Upstream templates
 * remain untouched. Generation below consumes these same patched resources. */
export function extendTrusteeHelm(helm: Helm, settings: TrusteeHelmSettings): void {
  const deployment = helm.apiObjects.find(object => object.kind === "Deployment");
  const service = helm.apiObjects.find(object => object.kind === "Service");
  if (helm.apiObjects.length !== 2 || !deployment || !service) throw new TypeError("Trustee: unexpected official chart topology");
  const { extensions } = settings;
  const spec = "/spec/template/spec", kbs = `${spec}/containers/0`;
  const original = deployment.toJson().spec.template.spec;
  if (original.containers.length !== 1 || original.containers[0].name !== "kbs" ||
      original.initContainers?.length !== 1 || original.initContainers[0].name !== "wait-for-as") {
    throw new TypeError("Trustee: unexpected official KBS workload");
  }
  deployment.addJsonPatch(
    JsonPatch.add("/spec/strategy", { type: "Recreate" }),
    JsonPatch.add(`${spec}/runtimeClassName`, "kata-qemu-snp"),
    JsonPatch.add(`${spec}/enableServiceLinks`, false),
    JsonPatch.remove(`${spec}/initContainers`),
    JsonPatch.replace(`${spec}/volumes`, extensions.volumes),
    JsonPatch.replace(`${kbs}/volumeMounts`, extensions.volumeMounts),
    JsonPatch.replace(`${kbs}/image`, extensions.image),
    JsonPatch.replace(`${kbs}/command`, extensions.command),
    JsonPatch.add(`${kbs}/args`, extensions.args),
    JsonPatch.add(`${kbs}/securityContext/readOnlyRootFilesystem`, true),
    JsonPatch.replace(`${kbs}/env/0`, { name: "RUST_LOG", value: "off" }),
    JsonPatch.replace(`${kbs}/ports/0/containerPort`, 8080),
    JsonPatch.remove(`${kbs}/readinessProbe`),
    JsonPatch.remove(`${kbs}/livenessProbe`),
    ...extensions.extraContainers.map(container => JsonPatch.add(`${spec}/containers/-`, container)),
  );
  service.addJsonPatch(JsonPatch.replace("/spec/ports/0/targetPort", "rats-tls"));
}

/** Generation and deployment use the same Helm output. Never
 * rebuild a parallel Pod spec that can drift from what the chart deploys. */
export function readTrusteeHelmPlan(helm: Helm, config: ReleaseConfig, settings: TrusteeHelmSettings) {
  const { values, extensions } = settings;
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
      spec.containers.length !== 1 + extensions.extraContainers.length ||
      !spec.volumes?.length || spec.volumes.some(volume => Object.keys(volume).sort().join() !== "emptyDir,name" ||
        volume.emptyDir?.medium !== "Memory")) fail();
  const kbs = spec.containers[0];
  if (kbs.name !== "kbs" || kbs.image !== extensions.image ||
      canonicalJson(kbs.command) !== canonicalJson(extensions.command) ||
      canonicalJson(kbs.args) !== canonicalJson(extensions.args)) fail();
  for (const container of spec.containers) {
    if (container.securityContext?.allowPrivilegeEscalation !== false ||
        container.securityContext.readOnlyRootFilesystem !== true ||
        container.securityContext.privileged ||
        canonicalJson(container.securityContext.capabilities?.drop) !== '["ALL"]' ||
        container.env?.some(variable => variable.valueFrom || typeof variable.value !== "string") || "envFrom" in container) fail();
  }
  for (const expected of extensions.extraContainers) {
    const actual = spec.containers.find(container => container.name === expected.name);
    if (canonicalJson(actual) !== canonicalJson(expected)) fail();
  }
  const svc = service!.toJson();
  if (svc.spec.type !== "ClusterIP" || svc.spec.ports.length !== 1 ||
      svc.spec.ports[0].port !== values.kbs.service.port || svc.spec.ports[0].targetPort !== "rats-tls" ||
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
