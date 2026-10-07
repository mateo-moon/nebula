import { ApiObject, JsonPatch } from "cdk8s";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ScaledJob,
  ScaledJobSpecJobTargetRefTemplateSpecInitContainersResourcesLimits as Limit,
  ScaledJobSpecJobTargetRefTemplateSpecInitContainersResourcesRequests as Request,
  ScaledJobSpecJobTargetRefTemplateSpecVolumesEmptyDirSizeLimit as Size,
} from "#imports/keda.sh";

// Same reviewed tools as the management refresher; no dependency on its
// service account, registry Secret, kubeconfig, or credential relay.
export const ECR_READER_AWS_CLI_IMAGE = "public.ecr.aws/aws-cli/aws-cli@sha256:9ef589924a9d9df06193db6a57ef88c5ccae1d19a71c6ac545bec3915f34f520";
export const ECR_READER_TOOLS_IMAGE = "docker.io/alpine/k8s@sha256:692239d739589247c4a791205ed9619c28ae85a21286e19a6211c04a62c56668";
export interface AwsEcrScaledJobReaderConfig {
  accountId: string;
  region: string;
  namespace: string;
  serviceAccount: string;
  readerRole: string;
  codeConfigMapName: string;
  credentialsPath: string;
  roleSessionName: string;
  errorLabel: string;
  /** Required remaining token lifetime. Default four hours, with at least
   * one hour beyond the existing job deadline for startup and clock margin. */
  minimumCredentialLifetimeSeconds?: number;
  images?: { awsCli: string; tools: string };
}

function credentialsPath(path: string): void {
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some(part => part === "." || part === ".."))
    throw new Error("Registry credentialsPath must be an absolute path without shell metacharacters or traversal");
}

/** act_runner config fragment. The caller chooses the opt-in environment key;
 * the runner's writable Docker config is not replaced. */
export function registryReaderRunnerConfig(config: { credentialsPath: string; environmentVariable: string }): string {
  credentialsPath(config.credentialsPath);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.environmentVariable)) throw new Error("Invalid registry environment variable");
  return `runner:
  envs:
    ${config.environmentVariable}: ${config.credentialsPath}
container:
  options: --volume=${config.credentialsPath}:${config.credentialsPath}:ro
  valid_volumes:
    - ${config.credentialsPath}
`;
}

/** Add one explicit WebIdentity exchange to an existing KEDA job. No new job,
 * schedule, credential relay or AWS service is created. Call once per scope/job. */
export function addAwsEcrScaledJobReader(scope: Construct, job: ScaledJob, config: AwsEcrScaledJobReaderConfig): void {
  const dns = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
  if (!/^\d{12}$/.test(config.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(config.region))
    throw new Error("Registry reader requires an explicit AWS account and region");
  for (const name of [config.namespace, config.serviceAccount, config.codeConfigMapName])
    if (!dns.test(name)) throw new Error("Invalid registry reader Kubernetes name");
  if (!/^[A-Za-z0-9+=,.@_/-]+$/.test(config.readerRole)) throw new Error("Invalid registry reader role");
  if (!/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(config.roleSessionName)) throw new Error("Invalid registry role session name");
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(config.errorLabel)) throw new Error("Invalid registry error label");
  credentialsPath(config.credentialsPath);
  const images = config.images ?? { awsCli: ECR_READER_AWS_CLI_IMAGE, tools: ECR_READER_TOOLS_IMAGE };
  for (const image of [images.awsCli, images.tools])
    if (!/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Registry tools require immutable image digests");
  const resource = job.toJson();
  const pod = resource.spec?.jobTargetRef?.template?.spec;
  const minimumLifetime = config.minimumCredentialLifetimeSeconds ?? 14400;
  const deadline = resource.spec?.jobTargetRef?.activeDeadlineSeconds;
  if (!Number.isInteger(minimumLifetime) || minimumLifetime > 43200 || minimumLifetime < 3601 ||
      !Number.isInteger(deadline) || deadline <= 0 || deadline + 3600 > minimumLifetime)
    throw new Error("Registry credential lifetime must cover the explicit job deadline plus one hour");
  if (resource.kind !== "ScaledJob" || !resource.apiVersion?.startsWith("keda.sh/") ||
      !pod || pod.securityContext?.fsGroup !== 1000 || !Array.isArray(pod.volumes) || !Array.isArray(pod.containers?.[0]?.volumeMounts) ||
      (pod.initContainers?.length ?? 0) > 0 ||
      pod.volumes.some((volume: { name: string }) => ["registry-identity", "registry-response", "registry-credentials", "registry-code"].includes(volume.name)))
    throw new Error("Registry reader requires a ScaledJob with fsGroup 1000, existing volumes/mounts and no conflicting init containers or registry volumes");
  const registry = `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com`;
  const script = readFileSync(new URL("./credentials.jq", import.meta.url), "utf8")
    .replace("14400", String(minimumLifetime))
    .replace("existing three-hour job deadline", minimumLifetime === 14400 ? "existing three-hour job deadline" : "configured job deadline");
  const exchange = readFileSync(new URL("./token.sh", import.meta.url), "utf8").replaceAll("__NEBULA_ROLE_SESSION__", config.roleSessionName).replaceAll("__NEBULA_ERROR_LABEL__", config.errorLabel);
  const name = config.codeConfigMapName;
  new ApiObject(scope, "registry-reader-account", { apiVersion: "v1", kind: "ServiceAccount",
    metadata: { name: config.serviceAccount, namespace: config.namespace }, automountServiceAccountToken: false });
  new ApiObject(scope, "registry-reader-code", { apiVersion: "v1", kind: "ConfigMap",
    metadata: { name, namespace: config.namespace }, data: { "credentials.jq": script, "token.sh": exchange } });
  const mount = (name: string, mountPath: string, readOnly = true) => ({ name, mountPath, readOnly });
  const securityContext = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
    readOnlyRootFilesystem: true, allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } };
  const base = "/spec/jobTargetRef/template/spec";
  const resources = (cpu: string, memory: string, limitCpu: string, limitMemory: string) => ({
    requests: { cpu: Request.fromString(cpu), memory: Request.fromString(memory) },
    limits: { cpu: Limit.fromString(limitCpu), memory: Limit.fromString(limitMemory) },
  });
  job.addJsonPatch(
    JsonPatch.add(`${base}/serviceAccountName`, config.serviceAccount),
    JsonPatch.add(`${base}/automountServiceAccountToken`, false),
    JsonPatch.add("/spec/jobTargetRef/template/metadata", { ...resource.spec.jobTargetRef.template.metadata, annotations: { ...resource.spec.jobTargetRef.template.metadata?.annotations, "checksum/registry-reader": createHash("sha256").update(script).update(exchange).digest("hex") } }),
    JsonPatch.add(`${base}/initContainers`, [{
      name: "registry-token", image: images.awsCli, securityContext,
      command: ["/bin/sh", "/code/token.sh"],
      env: [
        { name: "AWS_REGION", value: config.region },
        { name: "READER_ROLE_ARN", value: `arn:aws:iam::${config.accountId}:role/${config.readerRole}` },
        { name: "READER_TOKEN_FILE", value: "/aws/token" },
        { name: "AWS_STS_REGIONAL_ENDPOINTS", value: "regional" },
        { name: "AWS_EC2_METADATA_DISABLED", value: "true" }, { name: "AWS_PAGER", value: "" },
      ],
      resources: resources("50m", "128Mi", "500m", "256Mi"),
      volumeMounts: [mount("registry-identity", "/aws"), mount("registry-response", "/work", false), mount("registry-code", "/code")],
    }, {
      name: "registry-config", image: images.tools, securityContext,
      command: ["/bin/sh", "-ec", `umask 077
if ! jq -e --arg registry "$REGISTRY" --argjson now "$(date +%s)" -f /code/credentials.jq /work/ecr.json > /credentials/config.json 2>/dev/null; then
  echo '${config.errorLabel} registry credentials rejected' >&2
  exit 1
fi
chmod 0444 /credentials/config.json`],
      env: [{ name: "REGISTRY", value: registry }],
      resources: resources("20m", "32Mi", "200m", "96Mi"),
      volumeMounts: [mount("registry-response", "/work"), mount("registry-code", "/code"), mount("registry-credentials", "/credentials", false)],
    }]),
    JsonPatch.add(`${base}/volumes/-`, { name: "registry-identity", projected: {
      sources: [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } }],
    } }),
    JsonPatch.add(`${base}/volumes/-`, { name: "registry-response", emptyDir: { medium: "Memory", sizeLimit: Size.fromString("2Mi") } }),
    JsonPatch.add(`${base}/volumes/-`, { name: "registry-credentials", emptyDir: { medium: "Memory", sizeLimit: Size.fromString("2Mi") } }),
    JsonPatch.add(`${base}/volumes/-`, { name: "registry-code", configMap: { name } }),
    // The nested Docker daemon sees this one read-only directory. act_runner's
    // container.options mounts it into each selected job, including explicit
    // workflow container images. Neither JWT nor raw STS credentials is mounted.
    // The read gate opts into the configured environment variable: do not override the job's
    // ordinary writable Docker config used by existing GCR login workflows.
    JsonPatch.add(`${base}/containers/0/volumeMounts/-`, mount("registry-credentials", config.credentialsPath)),
  );
}
