import { ApiObject, Helm, JsonPatch } from "cdk8s";
import { Construct } from "constructs";
import type { DsseEnvelope } from "../confidential-guests/signed-releases";
import { awsAuthorityDeploymentId, verifyAwsAuthorityGenesis, type AwsAuthorityGenesis } from "./aws-authority";
import { awsCocoRelease, validateAwsCocoRelease, type AwsCocoRelease } from "./aws-coco-release";
import { requireValue } from "./aws-signatures";

export interface AwsCocoManagedConfig {
  readonly mode: "managed";
  /** Uses the account of Nebula's existing AWS provider. */
  readonly region?: "eu-west-1" | "us-east-2";
  readonly providerConfigName?: string;
  /** Existing platform network; the module creates all additional infrastructure. */
  readonly placement: { readonly vpcId: string; readonly workerSecurityGroupIds: readonly string[] };
  /** Public owner enrollment, produced by the owner's normal release pipeline. */
  readonly enrollment: DsseEnvelope;
  readonly peerPodsLimitPerNode?: number;
  /** Defaults to the immutable release shipped with this Nebula package. */
  readonly release?: AwsCocoRelease;
}
export function isManagedAwsCoco(value: unknown): value is AwsCocoManagedConfig {
  return !!value && typeof value === "object" && "mode" in value && value.mode === "managed";
}
export function validateManagedAwsCoco(config: AwsCocoManagedConfig): { release: AwsCocoRelease; deployment: string } {
  const release = config.release ?? awsCocoRelease();
  validateAwsCocoRelease(release);
  requireValue(config.region === undefined || ["eu-west-1", "us-east-2"].includes(config.region), "unsupported SNP region");
  requireValue(/^[a-z0-9-]+$/.test(config.providerConfigName ?? "default"), "invalid AWS provider");
  requireValue(/^vpc-[a-f0-9]{17}$/.test(config.placement.vpcId) && config.placement.workerSecurityGroupIds.length > 0 &&
    config.placement.workerSecurityGroupIds.length <= 10 && new Set(config.placement.workerSecurityGroupIds).size === config.placement.workerSecurityGroupIds.length &&
    config.placement.workerSecurityGroupIds.every(group => /^sg-[a-f0-9]{17}$/.test(group)), "platform VPC and worker groups required");
  requireValue(Number.isInteger(config.peerPodsLimitPerNode ?? 2) && (config.peerPodsLimitPerNode ?? 2) > 0 &&
    (config.peerPodsLimitPerNode ?? 2) <= 32, "bounded PodVM limit required");
  const genesis = JSON.parse(Buffer.from(config.enrollment.payload, "base64").toString("utf8")) as AwsAuthorityGenesis;
  const deployment = awsAuthorityDeploymentId(genesis);
  verifyAwsAuthorityGenesis(config.enrollment, deployment, release.authority.profile.release);
  requireValue(genesis.runtimeReleases.length === 1 && genesis.runtimeReleases[0] === release.runtime.profile.release, "runtime release mismatch");
  return { release, deployment };
}

/** Synthesize only public data and references to provider-created credentials. */
export class ManagedAwsCoco extends Construct {
  readonly resource: ApiObject;
  private readonly controller: ApiObject;
  private readonly role: ApiObject;
  private readonly clusterRole: ApiObject;
  readonly release: AwsCocoRelease;
  readonly deployment: string;
  readonly name: string;
  readonly credentialNames: Record<"controller" | "caa" | "cleanup", string>;
  constructor(scope: Construct, id: string, readonly namespace: string, readonly settings: AwsCocoManagedConfig) {
    super(scope, id);
    const validated = validateManagedAwsCoco(settings);
    this.release = validated.release; this.deployment = validated.deployment;
    this.name = "nebula-coco-" + this.deployment.slice(0, 20);
    this.credentialNames = { controller: this.name + "-controller", caa: this.name + "-caa", cleanup: this.name + "-cleanup" };
    const region = settings.region ?? "eu-west-1", provider = settings.providerConfigName ?? "default";
    const object = (kind: string, name: string, spec: { forProvider: Record<string, unknown>; [key: string]: unknown }) => {
      const { name: externalName, ...forProvider } = spec.forProvider;
      return new ApiObject(this, kind + "-" + name, {
        apiVersion: "iam.aws.upbound.io/v1beta1", kind, metadata: { name, annotations: { "argocd.argoproj.io/sync-wave": "-5",
          ...(typeof externalName === "string" ? { "crossplane.io/external-name": externalName } : {}) } },
        spec: { deletionPolicy: "Delete", providerConfigRef: { name: provider }, ...spec, forProvider },
      });
    };
    const policy = (statements: unknown[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
    const allowed = (Action: string[], Resource: string | string[], Condition?: unknown) => ({ Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
    const regional = { StringEquals: { "aws:RequestedRegion": region } };
    const tagged = { StringEquals: { "aws:RequestedRegion": region, "ec2:ResourceTag/NebulaCocoDeployment": this.deployment } };
    const guestName = this.name + "-guest";
    object("Role", guestName, { forProvider: { name: guestName, assumeRolePolicy: policy([
      { Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "ec2.amazonaws.com" } },
    ]) } });
    object("Policy", guestName + "-boot", { forProvider: { name: guestName + "-boot", policy: policy([
      allowed(["s3:GetObject"], `arn:aws:s3:::${this.name}-*/boot/${this.deployment}/*`),
    ]) } });
    object("RolePolicyAttachment", guestName + "-boot", { forProvider: { roleRef: { name: guestName }, policyArnRef: { name: guestName + "-boot" } } });
    object("InstanceProfile", guestName + "-profile", { forProvider: { name: guestName, roleRef: { name: guestName } } });
    const pass = allowed(["iam:PassRole"], `arn:aws:iam::*:role/${guestName}`, { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } });
    const read = allowed(["ec2:Describe*"], "*", regional);
    const terminate = allowed(["ec2:TerminateInstances"], `arn:aws:ec2:${region}:*:instance/*`, tagged);
    const controllerActions = ["ec2:CreateTags", "ec2:CreateVolume", "ec2:AttachVolume", "ec2:DeleteVolume", "ec2:DeleteSnapshot", "ec2:RegisterImage", "ec2:DeregisterImage",
      "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:CreateInternetGateway", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway",
      "ec2:CreateRouteTable", "ec2:CreateRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:DeleteRouteTable",
      "ec2:CreateVpcEndpoint", "ec2:DeleteVpcEndpoints", "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface",
      "ec2:AllocateAddress", "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:ReleaseAddress", "ec2:RunInstances", "ec2:StartInstances",
      "ec2:CreateLaunchTemplate", "ec2:DeleteLaunchTemplate"];
    const privileges = {
      controller: [read, terminate, pass, allowed(controllerActions, "*", regional),
        allowed(["iam:GetInstanceProfile"], `arn:aws:iam::*:instance-profile/${guestName}`),
        allowed(["ebs:StartSnapshot", "ebs:PutSnapshotBlock", "ebs:CompleteSnapshot"], `arn:aws:ec2:${region}::snapshot/*`, regional),
        allowed(["s3:CreateBucket", "s3:PutBucketOwnershipControls", "s3:GetBucketTagging", "s3:PutBucketTagging", "s3:PutBucketPublicAccessBlock", "s3:PutEncryptionConfiguration", "s3:ListBucket", "s3:DeleteBucket"], `arn:aws:s3:::${this.name}-*`),
        allowed(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], `arn:aws:s3:::${this.name}-*/boot/${this.deployment}/*`)],
      caa: [read, terminate, pass, allowed(["ec2:RunInstances", "ec2:CreateTags"], "*", regional)],
      cleanup: [read, terminate],
    };
    for (const purpose of ["controller", "caa", "cleanup"] as const) {
      const name = this.credentialNames[purpose];
      object("User", name, { forProvider: { name, tags: { NebulaCocoDeployment: this.deployment } } });
      object("Policy", name + "-policy", { forProvider: { name: name + "-policy", policy: policy(privileges[purpose]) } });
      object("UserPolicyAttachment", name + "-attach", { forProvider: { userRef: { name }, policyArnRef: { name: name + "-policy" } } });
      object("AccessKey", name + "-key", { forProvider: { userRef: { name }, status: "Active" }, writeConnectionSecretToRef: { name, namespace } });
    }
    new ApiObject(this, "crd", { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition",
      metadata: { name: "awsconfidentialruntimes.coco.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: { group: "coco.nebula.io", scope: "Namespaced", names: { kind: "AwsConfidentialRuntime", plural: "awsconfidentialruntimes", singular: "awsconfidentialruntime" },
        versions: [{ name: "v1alpha1", served: true, storage: true, subresources: { status: {} }, schema: { openAPIV3Schema: {
          type: "object", properties: { spec: { type: "object", required: ["deployment", "region", "placement", "genesis", "release"], properties: {
            deployment: { type: "string", pattern: "^[a-f0-9]{64}$" }, release: { type: "string", pattern: "^[a-f0-9]{64}$" },
            region: { type: "string", enum: ["eu-west-1", "us-east-2"] },
            placement: { type: "object", required: ["vpcId", "workerSecurityGroupIds"], properties: {
              vpcId: { type: "string", pattern: "^vpc-[a-f0-9]{17}$" }, workerSecurityGroupIds: { type: "array", minItems: 1, maxItems: 10,
                items: { type: "string", pattern: "^sg-[a-f0-9]{17}$" }, "x-kubernetes-list-type": "set" } } },
            genesis: { type: "object", required: ["payloadType", "payload", "signatures"], properties: {
              payloadType: { type: "string", enum: ["application/vnd.nebula.aws-coco-genesis.v1+json"] }, payload: { type: "string", maxLength: 22000 },
              signatures: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", required: ["keyid", "sig"], properties: {
                keyid: { type: "string", pattern: "^[a-f0-9]{64}$" }, sig: { type: "string", maxLength: 128 } } } } } },
          },
            "x-kubernetes-validations": [{ rule: "self == oldSelf", message: "Enrollment and release are immutable for this authority lineage" }] },
          status: { type: "object", "x-kubernetes-preserve-unknown-fields": true } },
        } } }],
      } });
    const namespaced = (apiVersion: string, kind: string, name: string, rest: object) => new ApiObject(this, kind + "-" + name, {
      apiVersion, kind, metadata: { name, namespace, annotations: { "argocd.argoproj.io/sync-wave": "-2" } }, ...rest,
    });
    namespaced("v1", "ServiceAccount", this.name, {});
    namespaced("coordination.k8s.io/v1", "Lease", this.name, { spec: {} });
    this.clusterRole = new ApiObject(this, "rbac", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: this.name, annotations: { "argocd.argoproj.io/sync-wave": "-3" } }, rules: [
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      { apiGroups: [""], resources: ["configmaps"], verbs: ["get"] },
    ] });
    new ApiObject(this, "rbac-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", metadata: { name: this.name, annotations: { "argocd.argoproj.io/sync-wave": "-3" } },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: this.name }, subjects: [{ kind: "ServiceAccount", name: this.name, namespace }] });
    this.role = namespaced("rbac.authorization.k8s.io/v1", "Role", this.name, { rules: [
      { apiGroups: ["coco.nebula.io"], resources: ["awsconfidentialruntimes", "awsconfidentialruntimes/status"], resourceNames: [this.name], verbs: ["get", "patch"] },
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: [this.name], verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["configmaps"], resourceNames: ["peer-pods-cm"], verbs: ["get", "patch"] },
      { apiGroups: ["apps"], resources: ["daemonsets"], resourceNames: ["cloud-api-adaptor-daemonset"], verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["create"] },
      { apiGroups: [""], resources: ["pods"], resourceNames: ["nebula-runtime-canary"], verbs: ["delete"] },
      { apiGroups: [""], resources: ["secrets"], resourceNames: [this.credentialNames.caa, this.credentialNames.cleanup], verbs: ["get"] },
      { apiGroups: [""], resources: ["secrets"], resourceNames: [this.name + "-admission"], verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
    ] });
    namespaced("rbac.authorization.k8s.io/v1", "RoleBinding", this.name, {
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: this.name }, subjects: [{ kind: "ServiceAccount", name: this.name, namespace }],
    });
    this.controller = namespaced("apps/v1", "Deployment", this.name, { spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { "coco.nebula.io/controller": this.name } },
      template: { metadata: { labels: { "coco.nebula.io/controller": this.name } }, spec: { serviceAccountName: this.name,
        nodeSelector: { "kubernetes.io/arch": "amd64" }, securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "controller", image: this.release.controllerImage, imagePullPolicy: "IfNotPresent", command: ["python3", "/app/controller.py"],
          env: [{ name: "NEBULA_RUNTIME_NAME", value: this.name }, { name: "POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
            { name: "AWS_EC2_METADATA_DISABLED", value: "true" }, { name: "PYTHONDONTWRITEBYTECODE", value: "1" }],
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "16Gi" }, limits: { memory: "1Gi", "ephemeral-storage": "24Gi" } },
          volumeMounts: [{ name: "aws", mountPath: "/var/run/secrets/nebula-aws", readOnly: true }, { name: "scratch", mountPath: "/tmp" }] }],
        volumes: [{ name: "aws", secret: { secretName: this.credentialNames.controller, defaultMode: 0o440 } }, { name: "scratch", emptyDir: { sizeLimit: "24Gi" } }],
      } } } });
    this.resource = new ApiObject(this, "runtime", { apiVersion: "coco.nebula.io/v1alpha1", kind: "AwsConfidentialRuntime",
      metadata: { name: this.name, namespace, annotations: { "argocd.argoproj.io/sync-wave": "-1" } }, spec: {
        deployment: this.deployment, region, placement: settings.placement, genesis: settings.enrollment, release: this.release.id,
      } });
  }

  configureHelm(helm: Helm, nodeSelector: Readonly<Record<string, string>>, runtimeClass: string): void {
    const resources = helm.apiObjects;
    // Keep the installer's API access until its DaemonSet has finished host
    // cleanup. Ordered pruning replaces Helm's retained RBAC/post-delete Job,
    // which would otherwise try to run after our namespace had been removed.
    const installer = resources.find(resource => resource.kind === "DaemonSet" && resource.name === "kata-as-coco-runtime");
    requireValue(installer, "upstream Kata installer contract changed");
    installer.addJsonPatch(JsonPatch.add("/metadata/annotations", { ...installer.toJson().metadata?.annotations,
      "argocd.argoproj.io/sync-options": "PrunePropagationPolicy=foreground" }));
    for (const [kind, suffix] of [["ServiceAccount", "sa"], ["ClusterRole", "role"], ["ClusterRoleBinding", "rb"]]) {
      const resource = resources.find(value => value.kind === kind && value.name === `kata-as-coco-runtime-${suffix}`);
      requireValue(resource?.toJson().metadata?.annotations?.["helm.sh/resource-policy"] === "keep", "upstream Kata RBAC contract changed");
      resource!.addJsonPatch(JsonPatch.remove("/metadata/annotations/helm.sh~1resource-policy"),
        JsonPatch.add("/metadata/annotations/argocd.argoproj.io~1sync-wave", "-4"));
    }
    for (const [kind, suffix] of [["ServiceAccount", "sa-cleanup"], ["ClusterRole", "cleanup-role"],
      ["ClusterRoleBinding", "cleanup-rb"], ["Job", "rb-cleanup"]]) {
      const resource = resources.find(value => value.kind === kind && value.name === `kata-as-coco-runtime-${suffix}`);
      requireValue(resource?.toJson().metadata?.annotations?.["helm.sh/hook"] === "post-delete", "upstream Kata cleanup contract changed");
      helm.node.tryRemoveChild(resource!.node.id);
    }
    const config = resources.find(resource => resource.kind === "ConfigMap" && resource.name === "peer-pods-cm");
    const caa = resources.find(resource => resource.kind === "DaemonSet" && resource.name === "cloud-api-adaptor-daemonset");
    const cleanup = resources.find(resource => resource.kind === "Deployment" && resource.toJson().metadata?.labels?.["app.kubernetes.io/created-by"] === "peerpodctrl");
    requireValue(config && caa && cleanup, "upstream peerpods contract changed");
    // GitOps owns the static settings; the controller owns these discovered
    // values. Even empty placeholders would make Argo self-heal overwrite them.
    // Removing them also works with plain apply, without caller-supplied ignores.
    for (const key of ["AWS_SUBNET_ID", "AWS_SG_IDS", "PODVM_AMI_ID", "PODVM_LAUNCHTEMPLATE_NAME"]) {
      requireValue(Object.hasOwn(config.toJson().data, key), "upstream peerpods configuration changed");
      config.addJsonPatch(JsonPatch.remove(`/data/${key}`));
    }
    const webhook = resources.find(resource => resource.kind === "MutatingWebhookConfiguration" && resource.name === "peer-pods-webhook-mutating-webhook-configuration");
    const admission = resources.find(resource => resource.kind === "Deployment" && resource.toJson().metadata?.labels?.["app.kubernetes.io/created-by"] === "peerpods-webhook");
    const service = resources.find(resource => resource.kind === "Service" && resource.name === "peer-pods-webhook-webhook-service");
    requireValue(webhook && admission && service && admission.toJson().metadata.namespace === this.namespace, "upstream admission contract changed");
    const label = "peer-pods-webhook-controller-manager";
    admission.addJsonPatch(JsonPatch.replace("/spec/selector/matchLabels/control-plane", label),
      JsonPatch.replace("/spec/template/metadata/labels/control-plane", label),
      JsonPatch.add("/spec/template/spec/nodeSelector", { "kubernetes.io/arch": "amd64" }),
      JsonPatch.add("/spec/strategy", { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }));
    service.addJsonPatch(JsonPatch.replace("/spec/selector/control-plane", label));
    const volumes = admission.toJson().spec.template.spec.volumes;
    const cert = volumes.findIndex((volume: any) => volume.name === "cert");
    requireValue(cert >= 0, "upstream admission certificate mount changed");
    admission.addJsonPatch(JsonPatch.replace(`/spec/template/spec/volumes/${cert}/secret/secretName`, this.name + "-admission"));
    // Restrict interception to this RuntimeClass. A missing/rotating certificate
    // must never prevent the controller or unrelated cluster Pods from starting.
    webhook.addJsonPatch(JsonPatch.remove("/webhooks/0/namespaceSelector"), JsonPatch.add("/webhooks/0/matchConditions", [{
      name: "aws-confidential-runtime", expression: `has(object.spec.runtimeClassName) && object.spec.runtimeClassName == ${JSON.stringify(runtimeClass)}`,
    }]));
    this.clusterRole.addJsonPatch(JsonPatch.add("/rules/-", { apiGroups: ["admissionregistration.k8s.io"], resources: ["mutatingwebhookconfigurations"],
      resourceNames: [webhook.name], verbs: ["get", "patch"] }));
    this.role.addJsonPatch(JsonPatch.add("/rules/-", { apiGroups: ["apps"], resources: ["deployments"], resourceNames: [admission.name], verbs: ["get", "patch"] }));
    for (const [name, value] of [["NEBULA_WEBHOOK_SERVICE", service.name], ["NEBULA_WEBHOOK_DEPLOYMENT", admission.name], ["NEBULA_WEBHOOK_CONFIGURATION", webhook.name]]) {
      this.controller.addJsonPatch(JsonPatch.add("/spec/template/spec/containers/0/env/-", { name, value }));
    }
    this.role.addJsonPatch(JsonPatch.add("/rules/-", { apiGroups: ["apps"], resources: ["deployments"],
      resourceNames: [cleanup.name], verbs: ["get", "patch"] }));
    this.controller.addJsonPatch(JsonPatch.add("/spec/template/spec/containers/0/env/-", {
      name: "NEBULA_CLEANUP_DEPLOYMENT", value: cleanup.name }));
    for (const [resource, purpose, image] of [[caa, "caa", this.release.caaImage], [cleanup, "cleanup", this.release.cleanupImage]] as const) {
      const spec = resource.toJson().spec.template.spec;
      resource.addJsonPatch(JsonPatch.add("/spec/template/spec/nodeSelector", { ...nodeSelector, "kubernetes.io/arch": "amd64" }),
        JsonPatch.replace("/spec/template/spec/containers/0/image", image),
        JsonPatch.replace("/spec/template/spec/containers/0/envFrom", spec.containers[0].envFrom.filter((value: any) => !value.secretRef)));
      for (const [name, key] of [["AWS_ACCESS_KEY_ID", "username"], ["AWS_SECRET_ACCESS_KEY", "password"]]) {
        resource.addJsonPatch(JsonPatch.add("/spec/template/spec/containers/0/env/-", { name,
          valueFrom: { secretKeyRef: { name: this.credentialNames[purpose], key } } }));
      }
      resource.addJsonPatch(JsonPatch.add("/spec/template/spec/containers/0/env/-", { name: "AWS_EC2_METADATA_DISABLED", value: "true" }));
    }
    const gate = { name: "managed-image-ready", image: this.release.controllerImage,
      command: ["python3", "-c", "import os,time;\nwhile not os.environ.get('PODVM_AMI_ID','').startswith('ami-'): time.sleep(10)"],
      envFrom: [{ configMapRef: { name: "peer-pods-cm" } }], securityContext: { runAsNonRoot: true, runAsUser: 65532,
        allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } };
    caa.addJsonPatch(caa.toJson().spec.template.spec.initContainers ? JsonPatch.add("/spec/template/spec/initContainers/-", gate) :
      JsonPatch.add("/spec/template/spec/initContainers", [gate]));
  }
}
