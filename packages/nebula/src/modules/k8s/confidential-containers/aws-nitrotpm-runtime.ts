import { ApiObject, Helm, JsonPatch } from "cdk8s";
import { Construct } from "constructs";
import * as awsEc2 from "../../../../imports/ec2.aws.upbound.io";
import type { ConfidentialContainersConfig } from "./index";

/** Platform inputs only. Workload policies and key approvals live in the
 * measured guest and independent verifier/KBS, never in host annotations. */
export interface AwsNitroTpmRuntimeConfig {
  accountId: string;
  /** Regions/instances retained for the SNP requirement; not proof of SNP. */
  region: "eu-west-1" | "us-east-2";
  imageId: string;
  instanceType: string;
  subnetId: string;
  securityGroupIds: string[];
  launchTemplateName: string;
  peerPodsLimitPerNode: number;
  caaRoleArn: string;
  cleanupRoleArn: string;
  /** Official upstream controller images, pinned by digest. */
  caaImage: string;
  cleanupImage: string;
}

export interface AwsNitroTpmLaunchTemplateConfig extends AwsNitroTpmRuntimeConfig {
  providerConfigName: string;
  rootDeviceName: string;
  rootVolumeSizeGiB: number;
  volumeKmsKeyArn: string;
}

/** The shipped verifier, guest bootstrap and image-staging sources. No I/O at import. */
export function awsNitroTpmAssetsUrl(): URL {
  return new URL("./aws-nitrotpm/", import.meta.url);
}

function requireConfig(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`ConfidentialContainers awsNitroTpm: ${message}`);
}

function validateRuntime(config: AwsNitroTpmRuntimeConfig): void {
  requireConfig(config && typeof config === "object", "explicit platform settings required");
  requireConfig(["eu-west-1", "us-east-2"].includes(config.region) && /^\d{12}$/.test(config.accountId) &&
    /^ami-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(config.imageId) &&
    /^(?:[cm]6a\.(?:large|xlarge|2xlarge|4xlarge|8xlarge)|c6a\.(?:12xlarge|16xlarge)|r6a\.(?:large|xlarge|2xlarge|4xlarge))$/.test(config.instanceType),
    "exact AMI and supported SNP region/instance settings required");
  requireConfig(/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(config.subnetId) &&
    Array.isArray(config.securityGroupIds) && config.securityGroupIds.length > 0 &&
    new Set(config.securityGroupIds).size === config.securityGroupIds.length &&
    config.securityGroupIds.every(group => /^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(group)),
    "exact private subnet/security group IDs required");
  requireConfig(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.launchTemplateName) &&
    Number.isSafeInteger(config.peerPodsLimitPerNode) && config.peerPodsLimitPerNode > 0,
    "launch template name and finite positive PodVM limit required");
  const role = new RegExp(`^arn:aws:iam::${config.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`);
  requireConfig(role.test(config.caaRoleArn) && role.test(config.cleanupRoleArn) && config.caaRoleArn !== config.cleanupRoleArn,
    "distinct CAA/cleanup web-identity roles in the selected account required");
  for (const [image, name] of [[config.caaImage, "cloud-api-adaptor"], [config.cleanupImage, "peerpodctrl"]]) {
    requireConfig(typeof image === "string" && ["ghcr.io", "quay.io"].some(host => {
      const prefix = `${host}/confidential-containers/${name}@sha256:`;
      return image.startsWith(prefix) && /^[a-f0-9]{64}$/.test(image.slice(prefix.length));
    }),
      "official digest-pinned CAA/cleanup images required");
  }
}

export function validateAwsNitroTpmConfig(config: ConfidentialContainersConfig): void {
  validateRuntime(config.awsNitroTpm!);
  requireConfig(config.version === undefined || config.version === "0.23.0", "chart 0.23.0 is the qualified rendering contract");
  requireConfig(config.debug !== true, "debug is disabled for the AWS runtime");
  requireConfig(config.nodeSelector && Object.keys(config.nodeSelector).length > 0 &&
    Object.values(config.nodeSelector).every(value => typeof value === "string") &&
    (!config.nodeSelector["kubernetes.io/arch"] || config.nodeSelector["kubernetes.io/arch"] === "amd64"),
    "explicit amd64 worker placement required");
  // Raw Helm overrides cannot replace typed security/lifecycle inputs. Local
  // runtime tuning remains available when this AWS route is omitted.
  const values = config.values ?? {};
  requireConfig(!Object.hasOwn(values, "peerpods"), "use typed AWS settings instead of peerpods values");
  const kata = values["kata-as-coco-runtime"] as Record<string, unknown> | undefined;
  requireConfig(!kata || Object.keys(kata).every(key => ["image", "resources", "tolerations", "affinity"].includes(key)),
    "raw Kata overrides may only tune image, resources, tolerations and affinity for this route");
}

/** Merge last so general values cannot change the AWS trust/transport inputs. */
export function awsNitroTpmValues(config: ConfidentialContainersConfig): Record<string, unknown> {
  const aws = config.awsNitroTpm!;
  return {
    "kata-as-coco-runtime": {
      deploymentMode: "daemonset", debug: false, devkit: false,
      nodeSelector: { ...config.nodeSelector, "kubernetes.io/arch": "amd64" },
      defaultShim: { amd64: (config.shims?.snp ?? true) ? "qemu-snp" : config.shims?.tdx ? "qemu-tdx" :
        config.shims?.cocoDev ? "qemu-coco-dev" : "remote" },
      shims: {
        disableAll: true,
        remote: { enabled: true, supportedArches: ["amd64"], allowedHypervisorAnnotations: [] },
        "qemu-snp": { enabled: config.shims?.snp ?? true },
        "qemu-nvidia-gpu-snp": { enabled: config.shims?.snp ?? true },
        "qemu-tdx": { enabled: config.shims?.tdx ?? false },
        "qemu-nvidia-gpu-tdx": { enabled: config.shims?.tdx ?? false },
        "qemu-coco-dev": { enabled: config.shims?.cocoDev ?? false },
        "qemu-coco-dev-runtime-rs": { enabled: config.shims?.cocoDev ?? false },
      },
      runtimeClasses: { enabled: config.createRuntimeClasses !== false, createDefault: false },
      snapshotter: { setup: ["nydus"] },
    },
    peerpods: {
      enabled: true, provider: "aws", "kata-deploy": { enabled: false },
      secrets: { mode: "reference", existingSecretName: "" },
      tlsProfile: { minVersion: "VersionTLS13" }, limit: String(aws.peerPodsLimitPerNode),
      providerConfigs: { aws: {
        AWS_REGION: aws.region, AWS_SUBNET_ID: aws.subnetId, AWS_SG_IDS: aws.securityGroupIds.join(","),
        PODVM_AMI_ID: aws.imageId, PODVM_INSTANCE_TYPE: aws.instanceType,
        USE_PODVM_LAUNCHTEMPLATE: "true", PODVM_LAUNCHTEMPLATE_NAME: aws.launchTemplateName,
        DISABLECVM: "false", USE_PUBLIC_IP: "false", SSH_KP_NAME: "", PODVM_DEVELOPER_MODE: "false",
        TLS_SKIP_VERIFY: "false", CLOUD_CONFIG_VERIFY: "true", PEERPODS_LIMIT_PER_NODE: String(aws.peerPodsLimitPerNode),
        ROOT_VOLUME_SIZE: "0", // Preserve the launch template's encrypted root mapping.
      } },
    },
  };
}

export function configureAwsNitroTpmRuntime(helm: Helm, config: ConfidentialContainersConfig, runtimeClass: string): void {
  const aws = config.awsNitroTpm!;
  const resources = helm.apiObjects;
  const remote = resources.filter(resource => resource.kind === "RuntimeClass" && resource.name === "kata-remote");
  requireConfig(remote.length === (config.createRuntimeClasses === false ? 0 : 1), "upstream remote RuntimeClass contract changed");
  if (remote.length) {
    requireConfig(remote[0].toJson().handler === "kata-remote", "upstream remote handler changed");
    // Alias the class, preserving the chart's actual handler and overhead.
    remote[0].addJsonPatch(JsonPatch.replace("/metadata/name", runtimeClass),
      JsonPatch.add("/scheduling/nodeSelector/kubernetes.io~1arch", "amd64"));
    for (const [key, value] of Object.entries(config.nodeSelector!)) {
      remote[0].addJsonPatch(JsonPatch.add(`/scheduling/nodeSelector/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, value));
    }
  }
  const caa = resources.find(resource => resource.kind === "DaemonSet" && resource.name === "cloud-api-adaptor-daemonset");
  const cleanup = resources.find(resource => resource.kind === "Deployment" &&
    resource.toJson().metadata?.labels?.["app.kubernetes.io/created-by"] === "peerpodctrl");
  requireConfig(caa && cleanup, "upstream CAA/cleanup chart contract changed");
  for (const [resource, roleArn, image] of [[caa, aws.caaRoleArn, aws.caaImage], [cleanup, aws.cleanupRoleArn, aws.cleanupImage]] as const) {
    const spec = resource.toJson().spec.template.spec;
    requireConfig(spec.containers.length === 1 && Array.isArray(spec.containers[0].env) && Array.isArray(spec.containers[0].envFrom),
      "upstream controller container contract changed");
    const token = { name: "aws-web-identity", projected: { sources: [
      { serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } },
    ] } };
    const mount = { name: "aws-web-identity", mountPath: "/var/run/secrets/aws", readOnly: true };
    resource.addJsonPatch(
      JsonPatch.add("/spec/template/spec/nodeSelector", { ...config.nodeSelector, "kubernetes.io/arch": "amd64" }),
      JsonPatch.replace("/spec/template/spec/containers/0/image", image),
      JsonPatch.replace("/spec/template/spec/containers/0/envFrom", spec.containers[0].envFrom.filter((source: any) => !source.secretRef)),
      JsonPatch.add(`/spec/template/spec/volumes${spec.volumes ? "/-" : ""}`, spec.volumes ? token : [token]),
      JsonPatch.add(`/spec/template/spec/containers/0/volumeMounts${spec.containers[0].volumeMounts ? "/-" : ""}`,
        spec.containers[0].volumeMounts ? mount : [mount]),
      JsonPatch.add("/spec/template/spec/containers/0/env/-", { name: "AWS_ROLE_ARN", value: roleArn }),
      JsonPatch.add("/spec/template/spec/containers/0/env/-", { name: "AWS_WEB_IDENTITY_TOKEN_FILE", value: "/var/run/secrets/aws/token" }),
      JsonPatch.add("/spec/template/spec/containers/0/env/-", { name: "AWS_EC2_METADATA_DISABLED", value: "true" }),
    );
  }
}

/** Provisioning helper for a management cluster. Neither this CPU option nor
 * a RuntimeClass registration is proof that a guest satisfies SNP/boot gates. */
export function awsNitroTpmLaunchTemplate(scope: Construct, id: string, config: AwsNitroTpmLaunchTemplateConfig): ApiObject {
  validateRuntime(config);
  requireConfig(/^[a-z0-9-]+$/.test(config.providerConfigName) && /^\/dev\/[a-z][a-z0-9]+$/.test(config.rootDeviceName) &&
    Number.isSafeInteger(config.rootVolumeSizeGiB) && config.rootVolumeSizeGiB >= 20 &&
    new RegExp(`^arn:aws:kms:${config.region}:${config.accountId}:key/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(config.volumeKmsKeyArn),
    "exact provider, encrypted public-image root storage and dedicated KMS key required");
  return new awsEc2.LaunchTemplate(scope, id, { metadata: { name: config.launchTemplateName }, spec: {
    providerConfigRef: { name: config.providerConfigName }, forProvider: {
      name: config.launchTemplateName, region: config.region, imageId: config.imageId, instanceType: config.instanceType,
      cpuOptions: [{ amdSevSnp: "enabled" }],
      metadataOptions: [{ httpEndpoint: "enabled", httpTokens: "required", httpPutResponseHopLimit: 1 }],
      networkInterfaces: [{ deviceIndex: 0, associatePublicIpAddress: "false", deleteOnTermination: "true",
        subnetId: config.subnetId, securityGroups: config.securityGroupIds, ipv6AddressCount: 0 }],
      blockDeviceMappings: [{ deviceName: config.rootDeviceName, ebs: [{ encrypted: "true", deleteOnTermination: "true",
        kmsKeyId: config.volumeKmsKeyArn, volumeSize: config.rootVolumeSizeGiB, volumeType: "gp3" }] }],
    },
  } });
}
