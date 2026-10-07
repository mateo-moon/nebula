import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EcrRepository } from "../ecr";
import { ImagePullSecret } from "../../../k8s/image-pull-secret";
import { OpenIdConnectProvider, OpenIdConnectProviderSpecDeletionPolicy, Policy, Role, RolePolicyAttachment } from "#imports/iam.aws.upbound.io";

export interface AwsImageRegistryRepository {
  /** Stable Kubernetes resource name. */
  name: string;
  /** AWS repository name; defaults to the Kubernetes name. */
  repositoryName?: string;
  tags?: Record<string, string>;
}

export interface AwsImageRegistryConfig {
  accountId: string;
  region: string;
  issuerUrl: string;
  providerRoleArn: string;
  awsProviderConfigName?: string;
  namespace: string;
  repositories: { runtime: AwsImageRegistryRepository; workload: AwsImageRegistryRepository; mirror: AwsImageRegistryRepository };
  roles: { puller: string; mirror: string; ciPublisher: string; ciReader: string };
  controllerPolicyName?: string;
  github: {
    providerName?: string;
    publisher: { subject: string; repositoryId: string; repositoryOwnerId: string; ref: string; workflow: string };
    readerSubjects: string[];
  };
  images: { awsCli: string; tools: string; crane: string };
  gcr: { saJsonRef: string; imagePrefixes: string[]; mirroredImages: string[] };
  distribution: {
    providerConfigName: string;
    kubeconfigSecretRef: { namespace: string; name: string; key: string };
    targets: { namespace: string; secretName: string; namespaceLabels?: Record<string, string> }[];
  };
  refresh?: {
    name?: string;
    initialJobName?: string;
    appLabel?: string;
    credentialsSecretName?: string;
    sourceSecretName?: string;
    expiryAnnotation?: string;
  };
  mirrorJob?: { namePrefix?: string; appLabel?: string };
}

const GITHUB_ISSUER = "token.actions.githubusercontent.com";

function validateConfig(config: AwsImageRegistryConfig, names: {
  refreshName: string; credentialsSecretName: string; sourceSecretName: string; expiryAnnotation: string;
  controllerPolicyName: string; initialJobName: string; mirrorJobPrefix: string;
}) {
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const identities = [config.namespace, ...Object.values(config.roles), names.refreshName,
    names.credentialsSecretName, names.sourceSecretName, names.controllerPolicyName, names.initialJobName,
    names.mirrorJobPrefix, config.distribution.providerConfigName, config.github.providerName ?? "github-actions",
    config.distribution.kubeconfigSecretRef.namespace, config.distribution.kubeconfigSecretRef.name,
    config.refresh?.appLabel ?? `${config.namespace}-refresh`, config.mirrorJob?.appLabel ?? config.repositories.mirror.name,
    ...config.distribution.targets.flatMap(target => [target.namespace, target.secretName])];
  if (identities.some(name => !dnsLabel.test(name))) throw new Error("Registry resource identities must be DNS labels");
  if (names.mirrorJobPrefix.length > 52) throw new Error("Registry mirror Job prefix exceeds 52 characters");
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(names.expiryAnnotation))
    throw new Error("Invalid registry credential expiry annotation");
  if (!/^[A-Za-z0-9._-]+$/.test(config.distribution.kubeconfigSecretRef.key)) throw new Error("Invalid kubeconfig Secret key");
  if (new Set(Object.values(config.roles)).size !== 4) throw new Error("Registry operations require distinct IAM roles");
  if (config.distribution.targets.length === 0 ||
      new Set(config.distribution.targets.map(target => target.namespace)).size !== config.distribution.targets.length)
    throw new Error("Registry distribution requires unique target namespaces");
  if (!config.gcr.imagePrefixes.length || new Set(config.gcr.imagePrefixes).size !== config.gcr.imagePrefixes.length ||
      config.gcr.imagePrefixes.some(prefix => !/^gcr\.io\/[a-z0-9-]+(?:\/[a-z0-9._-]+)+$/.test(prefix)))
    throw new Error("Registry source credential aliases must be unique GCR image paths");
  if (!config.gcr.mirroredImages.length) throw new Error("Registry mirror requires at least one pinned source image");
  if (Object.values(config.images).some(image => !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)))
    throw new Error("Registry tools must use immutable image digests");
  const publisher = config.github.publisher;
  if (!/^\d+$/.test(publisher.repositoryId) || !/^\d+$/.test(publisher.repositoryOwnerId) ||
      !/^refs\/heads\/[^*?\s]+$/.test(publisher.ref) ||
      !/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+@[a-f0-9]{40}$/.test(publisher.workflow) ||
      ![publisher.subject, ...config.github.readerSubjects].every(subject => /^repo:[^*?\s]+$/.test(subject)) ||
      config.github.readerSubjects.length === 0)
    throw new Error("Registry GitHub trust requires exact subjects, immutable repository IDs and a pinned workflow");
}

/** Cloud resources use Nebula's Crossplane constructs/bindings. The owning
 * cluster refreshes pull credentials; provider-kubernetes delivers them to targets.
 */
export class AwsImageRegistry extends Construct {
  constructor(scope: Construct, id: string, config: AwsImageRegistryConfig) {
    super(scope, id);
    const NAMESPACE = config.namespace;
    const REPOSITORY = config.repositories.runtime.name;
    const WORKLOAD_REPOSITORY = config.repositories.workload.name;
    const MIRROR_REPOSITORY = config.repositories.mirror.name;
    const PULL_ROLE = config.roles.puller;
    const MIRROR_ROLE = config.roles.mirror;
    const CI_PUSH_ROLE = config.roles.ciPublisher;
    const CI_PULL_ROLE = config.roles.ciReader;
    const CI_PUBLISHER_SUBJECT = config.github.publisher.subject;
    const CI_PUBLISHER_WORKFLOW = config.github.publisher.workflow;
    const CI_READER_SUBJECTS = config.github.readerSubjects;
    const AWS_CLI_IMAGE = config.images.awsCli;
    const REGISTRY_TOOLS_IMAGE = config.images.tools;
    const CRANE_IMAGE = config.images.crane;
    const MIRRORED_IMAGES = config.gcr.mirroredImages;
    const refreshName = config.refresh?.name ?? "pull-secret-refresh";
    const credentialsSecretName = config.refresh?.credentialsSecretName ?? "workload-pull-credentials";
    const sourceSecretName = config.refresh?.sourceSecretName ?? "gcr-pull-source";
    const expiryAnnotation = config.refresh?.expiryAnnotation ?? "registry.nebula.sh/ecr-expires-at";
    const controllerPolicyName = config.controllerPolicyName ?? `${NAMESPACE}-controller`;
    const initialJobName = config.refresh?.initialJobName ?? `${NAMESPACE}-initial-refresh`;
    const refreshAppLabel = config.refresh?.appLabel ?? `${NAMESPACE}-refresh`;
    const mirrorJobPrefix = config.mirrorJob?.namePrefix ?? MIRROR_REPOSITORY;
    const mirrorAppLabel = config.mirrorJob?.appLabel ?? MIRROR_REPOSITORY;
    validateConfig(config, { refreshName, credentialsSecretName, sourceSecretName, expiryAnnotation,
      controllerPolicyName, initialJobName, mirrorJobPrefix });
    const providerConfigRef = { name: config.awsProviderConfigName ?? "default" };
    const raw = (id: string, manifest: any) => new ApiObject(this, id, manifest);
    const metadata = (name: string) => ({ name, namespace: NAMESPACE });
    const issuer = new URL(config.issuerUrl);
    if (issuer.protocol !== "https:" || issuer.search || issuer.hash || issuer.username || issuer.password)
      throw new Error("Registry identity requires an HTTPS OIDC issuer");
    const issuerKey = `${issuer.host}${issuer.pathname.replace(/\/$/, "")}`;
    const providerRolePrefix = `arn:aws:iam::${config.accountId}:role/`;
    if (!config.providerRoleArn.startsWith(providerRolePrefix)) throw new Error("Crossplane role account mismatch");
    const roleArn = (name: string) => `${providerRolePrefix}${name}`;

    const repo = new EcrRepository(this, "images", {
      name: REPOSITORY, repositoryName: config.repositories.runtime.repositoryName ?? REPOSITORY,
      accountId: config.accountId, region: config.region, providerConfigRef: providerConfigRef.name,
      exclusivePush: true, retainContent: true,
      grants: [{ roleName: PULL_ROLE, access: "pull" }, { roleName: CI_PUSH_ROLE, access: "push" },
        { roleName: CI_PULL_ROLE, access: "pull" }],
      tags: config.repositories.runtime.tags,
    });
    const mirror = new EcrRepository(this, "mirror", {
      name: MIRROR_REPOSITORY, repositoryName: config.repositories.mirror.repositoryName ?? MIRROR_REPOSITORY,
      accountId: config.accountId, region: config.region, providerConfigRef: providerConfigRef.name,
      grants: [{ roleName: MIRROR_ROLE, access: "push" }, { roleName: CI_PULL_ROLE, access: "pull" }],
      tags: config.repositories.mirror.tags,
    });
    // Workload publication uses ordinary AWS IAM authorization. Only runtime
    // images above require the exclusive CI writer and content-retention policy.
    const workload = new EcrRepository(this, "workload-images", {
      name: WORKLOAD_REPOSITORY, repositoryName: config.repositories.workload.repositoryName ?? WORKLOAD_REPOSITORY,
      accountId: config.accountId, region: config.region, providerConfigRef: providerConfigRef.name,
      grants: [{ roleName: PULL_ROLE, access: "pull" }],
      tags: config.repositories.workload.tags,
    });
    // Bootstrap already grants IAM management. Add only these repositories' ECR
    // control actions; image publishers never receive these permissions.
    new Policy(this, "controller-policy", {
      metadata: { name: controllerPolicyName, annotations: { "crossplane.io/external-name": controllerPolicyName } },
      spec: { providerConfigRef, forProvider: {
        policy: JSON.stringify({ Version: "2012-10-17", Statement: [{
          Effect: "Allow", Resource: [repo.repositoryArn, mirror.repositoryArn, workload.repositoryArn],
          Action: ["ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:ListTagsForResource", "ecr:TagResource", "ecr:UntagResource", "ecr:PutImageTagMutability", "ecr:PutImageScanningConfiguration"],
        }, {
          Effect: "Allow", Resource: repo.repositoryArn,
          Action: ["ecr:GetRepositoryPolicy", "ecr:SetRepositoryPolicy"],
        }] }),
      } },
    });
    new RolePolicyAttachment(this, "controller-attachment", {
      metadata: { name: controllerPolicyName },
      spec: { providerConfigRef, forProvider: {
        role: config.providerRoleArn.slice(providerRolePrefix.length),
        policyArnRef: { name: controllerPolicyName },
      } },
    });
    raw("namespace", { apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } });
    for (const [name, sa] of [[PULL_ROLE, "puller"], [MIRROR_ROLE, "mirror"]]) {
      new Role(this, `role-${sa}`, {
        metadata: { name, annotations: { "crossplane.io/external-name": name } },
        spec: { providerConfigRef, forProvider: {
          assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{
            Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
            Principal: { Federated: `arn:aws:iam::${config.accountId}:oidc-provider/${issuerKey}` },
            Condition: { StringEquals: {
              [`${issuerKey}:aud`]: "sts.amazonaws.com",
              [`${issuerKey}:sub`]: `system:serviceaccount:${NAMESPACE}:${sa}`,
            } },
          }] }),
        } },
      });
      raw(`sa-${sa}`, { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata(sa), automountServiceAccountToken: false });
    }
    const githubProviderArn = `arn:aws:iam::${config.accountId}:oidc-provider/${GITHUB_ISSUER}`;
    new OpenIdConnectProvider(this, "github-actions", {
      metadata: { name: config.github.providerName ?? "github-actions", annotations: { "crossplane.io/external-name": githubProviderArn } },
      spec: { providerConfigRef, deletionPolicy: OpenIdConnectProviderSpecDeletionPolicy.ORPHAN, forProvider: {
        url: `https://${GITHUB_ISSUER}`, clientIdList: ["sts.amazonaws.com"],
      } },
    });
    new Role(this, "role-ci-publisher", {
      metadata: { name: CI_PUSH_ROLE, annotations: { "crossplane.io/external-name": CI_PUSH_ROLE } },
      spec: { providerConfigRef, forProvider: {
        assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{
          Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
          Principal: { Federated: githubProviderArn },
          Condition: { StringEquals: {
            [`${GITHUB_ISSUER}:aud`]: "sts.amazonaws.com",
            [`${GITHUB_ISSUER}:sub`]: CI_PUBLISHER_SUBJECT,
            [`${GITHUB_ISSUER}:repository_id`]: config.github.publisher.repositoryId,
            [`${GITHUB_ISSUER}:repository_owner_id`]: config.github.publisher.repositoryOwnerId,
            [`${GITHUB_ISSUER}:ref`]: config.github.publisher.ref,
            [`${GITHUB_ISSUER}:job_workflow_ref`]: CI_PUBLISHER_WORKFLOW,
          } },
        }] }),
      } },
    });
    new Role(this, "role-ci-reader", {
      metadata: { name: CI_PULL_ROLE, annotations: { "crossplane.io/external-name": CI_PULL_ROLE } },
      spec: { providerConfigRef, forProvider: {
        assumeRolePolicy: JSON.stringify({ Version: "2012-10-17", Statement: [{
          Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
          Principal: { Federated: githubProviderArn },
          Condition: { StringEquals: {
            [`${GITHUB_ISSUER}:aud`]: "sts.amazonaws.com",
            [`${GITHUB_ISSUER}:sub`]: CI_READER_SUBJECTS,
          } },
        }] }),
      } },
    });
    new ImagePullSecret(this, "gcr-source", {
      registry: "gcr.io", saJsonRef: config.gcr.saJsonRef,
      namespaces: [NAMESPACE], secretName: sourceSecretName, createNamespaces: false,
    });

    raw("refresh-rbac", {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: metadata(refreshName),
      rules: [
        { apiGroups: [""], resources: ["secrets"], verbs: ["get", "update"], resourceNames: [credentialsSecretName] },
        // Kubernetes cannot restrict CREATE by resourceNames. This service
        // account can create Secrets only in this dedicated namespace.
        { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
      ],
    });
    raw("refresh-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: metadata(refreshName),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: refreshName },
      subjects: [{ kind: "ServiceAccount", name: "puller", namespace: NAMESPACE }],
    });
    const script = readFileSync(new URL("./registry.sh", import.meta.url), "utf8")
      .replaceAll("__CREDENTIALS_SECRET__", credentialsSecretName)
      .replaceAll("__EXPIRY_ANNOTATION__", expiryAnnotation);
    const credentials = readFileSync(new URL("./credentials.jq", import.meta.url), "utf8")
      .replace("__GCR_ALIASES__", config.gcr.imagePrefixes.map(prefix =>
        `${JSON.stringify(prefix)}: $auths["gcr.io"],`).join("\n    "))
      .replace("__RUNTIME_REPOSITORY__", JSON.stringify("/" + (config.repositories.runtime.repositoryName ?? REPOSITORY)))
      .replace("__WORKLOAD_REPOSITORY__", JSON.stringify("/" + (config.repositories.workload.repositoryName ?? WORKLOAD_REPOSITORY)));
    const scriptHash = createHash("sha256").update(script).update(credentials).digest("hex");
    raw("refresh-code", { apiVersion: "v1", kind: "ConfigMap", metadata: metadata(refreshName),
      data: { "registry.sh": script, "credentials.jq": credentials } });
    const securityContext = { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };
    const podSecurityContext = { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } };
    const ecrToken = (role: string) => ({
      name: "ecr-token", image: AWS_CLI_IMAGE, securityContext,
      command: ["/bin/sh", "-ec", "umask 077; aws ecr get-authorization-token --output json > /work/ecr.json"],
      env: [
        { name: "AWS_REGION", value: config.region }, { name: "AWS_STS_REGIONAL_ENDPOINTS", value: "regional" },
        { name: "AWS_ROLE_ARN", value: roleArn(role) },
        { name: "AWS_WEB_IDENTITY_TOKEN_FILE", value: "/aws/token" },
        { name: "AWS_EC2_METADATA_DISABLED", value: "true" }, { name: "AWS_PAGER", value: "" }, { name: "HOME", value: "/work" },
      ],
      resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      volumeMounts: [{ name: "aws-token", mountPath: "/aws", readOnly: true }, { name: "work", mountPath: "/work" }],
    });
    const awsToken = { name: "aws-token", projected: { sources: [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } }] } };
    const work = { name: "work", emptyDir: { medium: "Memory", sizeLimit: "4Mi" } };
    const gcrSource = { name: "gcr", secret: { secretName: sourceSecretName } };
    const podTemplate = {
      metadata: { labels: { app: refreshAppLabel }, annotations: { "checksum/script": scriptHash } },
      spec: {
        serviceAccountName: "puller", automountServiceAccountToken: true, restartPolicy: "Never",
        securityContext: podSecurityContext,
        initContainers: [ecrToken(PULL_ROLE)],
        containers: [{
          name: "refresh", image: REGISTRY_TOOLS_IMAGE, securityContext,
          command: ["/bin/sh", "/code/registry.sh", "refresh"],
          env: [{ name: "REGISTRY", value: repo.registry }, { name: "SECRET_NAMESPACE", value: NAMESPACE }],
          resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } },
          volumeMounts: [
            { name: "work", mountPath: "/work" }, { name: "code", mountPath: "/code", readOnly: true },
            { name: "gcr", mountPath: "/gcr", readOnly: true },
          ],
        }],
        volumes: [awsToken, work, { name: "code", configMap: { name: refreshName } }, gcrSource],
      },
    };
    const jobSpec = { backoffLimit: 6, activeDeadlineSeconds: 600, template: podTemplate };
    raw("initial-refresh", {
      apiVersion: "batch/v1", kind: "Job", metadata: { ...metadata(initialJobName), annotations: {
        "argocd.argoproj.io/hook": "Sync", "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation,HookSucceeded",
        "argocd.argoproj.io/sync-wave": "1",
      } }, spec: jobSpec,
    });
    raw("refresh-schedule", {
      apiVersion: "batch/v1", kind: "CronJob", metadata: metadata(refreshName),
      spec: { schedule: "*/30 * * * *", concurrencyPolicy: "Forbid", startingDeadlineSeconds: 300,
        successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 2, jobTemplate: { spec: jobSpec } },
    });

    raw("destination-provider", {
      apiVersion: "kubernetes.crossplane.io/v1alpha1", kind: "ProviderConfig",
      metadata: { name: config.distribution.providerConfigName },
      spec: { credentials: { source: "Secret", secretRef: config.distribution.kubeconfigSecretRef } },
    });
    // Namespace and pull Secret have ONE owner: this module. The workload app
    // consumes them and must not render a competing Namespace or Secret.
    for (const destination of config.distribution.targets) {
      const target = destination.namespace;
      raw("destination-namespace-" + target, {
        apiVersion: "kubernetes.crossplane.io/v1alpha2", kind: "Object", metadata: { name: target + "-namespace" },
        spec: { deletionPolicy: "Orphan", providerConfigRef: { name: config.distribution.providerConfigName }, forProvider: { manifest: {
          apiVersion: "v1", kind: "Namespace", metadata: { name: target, ...(destination.namespaceLabels ? { labels: destination.namespaceLabels } : {}) },
        } } },
      });
      raw("destination-pull-secret-" + target, {
        apiVersion: "kubernetes.crossplane.io/v1alpha2", kind: "Object", metadata: {
          name: target + "-pull-secret", annotations: { "argocd.argoproj.io/sync-wave": "2" },
        },
        spec: {
          deletionPolicy: "Orphan", providerConfigRef: { name: config.distribution.providerConfigName },
          references: [
            { dependsOn: { apiVersion: "kubernetes.crossplane.io/v1alpha2", kind: "Object", name: target + "-namespace" } },
            { patchesFrom: { apiVersion: "v1", kind: "Secret", namespace: NAMESPACE, name: credentialsSecretName, fieldPath: "data" }, toFieldPath: "data" },
            { patchesFrom: { apiVersion: "v1", kind: "Secret", namespace: NAMESPACE, name: credentialsSecretName, fieldPath: "metadata.annotations" }, toFieldPath: "metadata.annotations" },
          ],
          forProvider: { manifest: { apiVersion: "v1", kind: "Secret", metadata: { namespace: target, name: destination.secretName }, type: "kubernetes.io/dockerconfigjson" } },
        },
      });
    }

    // The mirror identity copies each declared GCR image into the mirror repository under its own digest, with the
    // in-cluster GCR pull source. The Job's name follows its content: a changed list is a new Job, and a copy the
    // mirror already holds is skipped.
    const copies = MIRRORED_IMAGES.map((source, index) => {
      const digest = /^gcr\.io\/[a-z0-9-]+(?:\/[a-z0-9._-]+)+@(sha256:[a-f0-9]{64})$/.exec(source)?.[1];
      if (!digest) throw new Error("A mirrored image is a GCR reference by digest");
      return {
        name: `copy-${index}`, image: CRANE_IMAGE, securityContext,
        args: ["copy", source, `${mirror.repositoryUrl}@${digest}`],
        env: [{ name: "DOCKER_CONFIG", value: "/work/docker" }],
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "1", memory: "512Mi" } },
        volumeMounts: [{ name: "work", mountPath: "/work", readOnly: true }],
      };
    });
    if (new Set(copies.map(c => c.args[2])).size !== copies.length) throw new Error("A mirrored digest is listed twice");
    const mirrorSpec = { backoffLimit: 6, activeDeadlineSeconds: 1800, template: {
      metadata: { labels: { app: mirrorAppLabel } },
      spec: {
        serviceAccountName: "mirror", automountServiceAccountToken: false, restartPolicy: "Never",
        securityContext: podSecurityContext,
        initContainers: [ecrToken(MIRROR_ROLE), {
          name: "docker-config", image: REGISTRY_TOOLS_IMAGE, securityContext,
          command: ["/bin/sh", "/code/registry.sh", "mirror"],
          env: [{ name: "REGISTRY", value: mirror.registry }, { name: "DOCKER_CONFIG", value: "/work/docker" }],
          resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } },
          volumeMounts: [
            { name: "work", mountPath: "/work" }, { name: "code", mountPath: "/code", readOnly: true },
            { name: "gcr", mountPath: "/gcr", readOnly: true },
          ],
        }],
        containers: copies,
        volumes: [awsToken, work, gcrSource, { name: "code", configMap: { name: refreshName } }],
      },
    } };
    const mirrorHash = createHash("sha256").update(JSON.stringify(mirrorSpec)).update(script).update(credentials)
      .digest("hex").slice(0, 10);
    raw("mirror-job", {
      apiVersion: "batch/v1", kind: "Job", metadata: { ...metadata(`${mirrorJobPrefix}-${mirrorHash}`),
        annotations: { "argocd.argoproj.io/sync-wave": "3" } }, spec: mirrorSpec,
    });
  }
}
