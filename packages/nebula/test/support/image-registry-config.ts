import { Testing } from "cdk8s";
import { AwsImageRegistry, type AwsImageRegistryConfig } from "../../src/modules/infra/aws/image-registry";

export const registryConfig: AwsImageRegistryConfig = {
  accountId: "123456789012", region: "eu-central-1", issuerUrl: "https://issuer.example.test",
  providerRoleArn: "arn:aws:iam::123456789012:role/crossplane", namespace: "registry",
  repositories: { runtime: { name: "runtime", repositoryName: "images/runtime" },
    workload: { name: "workload", repositoryName: "images/workload" }, mirror: { name: "mirror" } },
  roles: { puller: "registry-puller", mirror: "registry-mirror", ciPublisher: "registry-publisher", ciReader: "registry-reader" },
  github: {
    publisher: { subject: "repo:example@123/runtime@456:ref:refs/heads/main", repositoryId: "456",
      repositoryOwnerId: "123", ref: "refs/heads/main",
      workflow: `example/runtime/.github/workflows/publish.yml@${"a".repeat(40)}` },
    readerSubjects: ["repo:example@123/runtime@456:pull_request"],
  },
  images: {
    awsCli: "public.ecr.aws/aws-cli/aws-cli@sha256:9ef589924a9d9df06193db6a57ef88c5ccae1d19a71c6ac545bec3915f34f520",
    tools: "docker.io/alpine/k8s@sha256:692239d739589247c4a791205ed9619c28ae85a21286e19a6211c04a62c56668",
    crane: "gcr.io/go-containerregistry/crane@sha256:1f968817b95790bed063f71175aa6b8ff879fa17064020415f3e18bb6e6a36e1",
  },
  gcr: { saJsonRef: '{"type":"service_account","private_key":"synthetic-test-only"}',
    imagePrefixes: ["gcr.io/example-project/runtime", "gcr.io/example-project/second"],
    mirroredImages: [`gcr.io/example-project/runtime@sha256:${"b".repeat(64)}`] },
  distribution: { providerConfigName: "workload-registry", kubeconfigSecretRef: { namespace: "clusters", name: "workload-kubeconfig", key: "value" },
    targets: [{ namespace: "first-app", secretName: "registry-auth" }, { namespace: "second-app", secretName: "image-auth",
      namespaceLabels: { "pod-security.kubernetes.io/enforce": "restricted" } }] },
};

export function registryResources(config: AwsImageRegistryConfig = structuredClone(registryConfig)) {
  const chart = Testing.chart();
  new AwsImageRegistry(chart, "registry", config);
  return Testing.synth(chart);
}

export const registryCode = () => registryResources().find(resource => resource.kind === "ConfigMap")!.data as Record<string, string>;
