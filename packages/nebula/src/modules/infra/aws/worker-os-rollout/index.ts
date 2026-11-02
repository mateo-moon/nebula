import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { awsHostPreK0sCommands, validateAwsHostProfile, type AwsHostProfile } from "../host-profile";

export interface AwsWorkerOsRolloutOptions {
  /** Separate, reviewed activation identifier. Changing an AMI never sets this. */
  generation: string;
  /** Exact numeric version prepared and acknowledged before activation. */
  launchTemplateVersion: string;
  sourceSshUser: string;
  /** Multi-architecture runtime built from this directory, pinned by digest. */
  image: string;
  /** Existing approved IRSA role; its trust must allow this Job's service account. */
  roleArn: string;
  accountId: string;
  /** Absolute UTC deadline bounds retries across Job restarts. */
  deadline: string;
  /** Existing child-cluster client-certificate kubeconfig, under key value. */
  workloadKubeconfigSecretName: string;
}
export interface AwsWorkerOsRolloutConfig extends AwsWorkerOsRolloutOptions {
  nodeName: string;
  namespace: string;
  region: string;
  availabilityZone: string;
  launchTemplateName: string;
  eipName: string;
  dataVolumeName?: string;
  dataVgName: string;
  providerConfigName: string;
  targetAmi: string;
  hostProfile: AwsHostProfile;
}
export function validateAwsWorkerOsRollout(config: AwsWorkerOsRolloutOptions): void {
  if (!/^[a-z0-9][a-z0-9.-]{0,39}$/.test(config.generation)) throw new Error("Invalid OS rollout generation");
  if (!/^[1-9][0-9]*$/.test(config.launchTemplateVersion)) throw new Error("OS rollout requires a numeric launch-template version");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.sourceSshUser)) throw new Error("Invalid source SSH user");
  if (!/^\d{12}$/.test(config.accountId) || !config.roleArn.startsWith(`arn:aws:iam::${config.accountId}:role/`)) throw new Error("OS rollout role/account mismatch");
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error("OS rollout runtime must be pinned by digest");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(config.deadline) || !Number.isFinite(Date.parse(config.deadline))) throw new Error("OS rollout requires an absolute UTC deadline");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(config.workloadKubeconfigSecretName)) throw new Error("Invalid workload kubeconfig Secret name");
}

/** One bounded management Job, one persistent journal and one per-worker lock.
 * Existing AWS/CAPI ownership remains with the current controllers. */
export class AwsWorkerOsRollout extends Construct {
  public readonly job: ApiObject;
  constructor(scope: Construct, id: string, config: AwsWorkerOsRolloutConfig) {
    super(scope, id);
    validateAwsWorkerOsRollout(config);
    validateAwsHostProfile(config.hostProfile);
    for (const value of [config.nodeName, config.namespace, config.launchTemplateName, config.eipName, config.dataVgName, config.providerConfigName])
      if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(value)) throw new Error("Invalid OS rollout resource identity");
    if (!/^ami-[a-f0-9]{8}(?:[a-f0-9]{9})?$/.test(config.targetAmi) || !config.availabilityZone.startsWith(config.region)) throw new Error("Invalid OS rollout cloud identity");
    const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
    const name = `${config.nodeName.slice(0, 36)}-os-${hash}`;
    const lockName = `${config.nodeName.slice(0, 45)}-os-lock`;
    const journalName = `${name}-state`;
    const meta = (resourceName = name) => ({ name: resourceName, namespace: config.namespace });
    const retain = { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" };
    const request = { ...config, lockName, journalName,
      hostCheck: awsHostPreK0sCommands(config.hostProfile).join("; ") || "true" };
    for (const resourceName of [lockName, journalName]) new ApiObject(this, resourceName, {
      apiVersion: "v1", kind: "ConfigMap", metadata: { ...meta(resourceName), annotations: retain }, data: {},
    });
    new ApiObject(this, "request", { apiVersion: "v1", kind: "ConfigMap", metadata: meta(`${name}-request`),
      immutable: true, data: { "request.json": JSON.stringify(request) } });
    const scripts = Object.fromEntries(["engine.py", "runtime.py"].map(file => [file, readFileSync(new URL(file, import.meta.url), "utf8")]));
    new ApiObject(this, "scripts", { apiVersion: "v1", kind: "ConfigMap", metadata: meta(`${name}-scripts`), immutable: true, data: scripts });
    new ApiObject(this, "account", { apiVersion: "v1", kind: "ServiceAccount", metadata: meta() });
    const rule = (group: string, resources: string[], verbs: string[], resourceNames?: string[]) => ({ apiGroups: [group], resources, verbs, ...(resourceNames ? { resourceNames } : {}) });
    new ApiObject(this, "role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: meta(), rules: [
      rule("", ["configmaps"], ["get", "patch"], [lockName, journalName]),
      rule("cluster.x-k8s.io", ["machinedeployments"], ["get", "patch"], [config.nodeName]),
      rule("cluster.x-k8s.io", ["machinesets"], ["get", "list", "patch"]),
      rule("cluster.x-k8s.io", ["machines"], ["get", "list", "patch", "delete"]),
      rule("infrastructure.cluster.x-k8s.io", ["remotemachines"], ["get", "list"]),
      rule("infrastructure.cluster.x-k8s.io", ["pooledremotemachines"], ["get", "patch"], [config.nodeName]),
    ] });
    new ApiObject(this, "cluster-role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name }, rules: [
      rule("nebula.io", ["xworkers"], ["get"], [config.nodeName]),
      rule("autoscaling.aws.upbound.io", ["autoscalinggroups"], ["get"], [config.nodeName]),
      rule("ec2.aws.upbound.io", ["launchtemplates"], ["get"], [config.launchTemplateName]),
      rule("ec2.aws.upbound.io", ["eips"], ["get"], [config.eipName]),
      ...(config.dataVolumeName ? [rule("ec2.aws.upbound.io", ["ebsvolumes"], ["get"], [config.dataVolumeName])] : []),
    ] });
    for (const cluster of [false, true]) new ApiObject(this, cluster ? "cluster-binding" : "binding", {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: cluster ? "ClusterRoleBinding" : "RoleBinding",
      metadata: cluster ? { name } : meta(), roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: cluster ? "ClusterRole" : "Role", name },
      subjects: [{ kind: "ServiceAccount", name, namespace: config.namespace }],
    });
    this.job = new ApiObject(this, "job", { apiVersion: "batch/v1", kind: "Job", metadata: {
      ...meta(), annotations: { ...retain, "argocd.argoproj.io/sync-wave": "5" } },
      spec: { parallelism: 1, completions: 1, backoffLimit: 3, activeDeadlineSeconds: 7200,
        template: { spec: { serviceAccountName: name, restartPolicy: "OnFailure",
          securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "replace", image: config.image, command: ["python3", "-B", "/opt/rollout/runtime.py"],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
            env: [{ name: "AWS_ROLE_ARN", value: config.roleArn }, { name: "AWS_WEB_IDENTITY_TOKEN_FILE", value: "/var/run/aws/token" },
              { name: "AWS_REGION", value: config.region }, { name: "AWS_EC2_METADATA_DISABLED", value: "true" }],
            volumeMounts: [{ name: "scripts", mountPath: "/opt/rollout", readOnly: true }, { name: "request", mountPath: "/etc/rollout", readOnly: true },
              { name: "workload", mountPath: "/etc/workload", readOnly: true }, { name: "aws-token", mountPath: "/var/run/aws", readOnly: true },
              { name: "tmp", mountPath: "/tmp" }],
          }], volumes: [{ name: "scripts", configMap: { name: `${name}-scripts` } }, { name: "request", configMap: { name: `${name}-request` } },
            { name: "workload", secret: { secretName: config.workloadKubeconfigSecretName, defaultMode: 288, items: [{ key: "value", path: "value" }] } },
            { name: "aws-token", projected: { sources: [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } }] } },
            { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }],
        } },
      },
    });
  }
}
