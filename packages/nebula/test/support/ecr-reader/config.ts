import { Testing } from "cdk8s";
import { ScaledJob } from "#imports/keda.sh";
import { addAwsEcrScaledJobReader, type AwsEcrScaledJobReaderConfig } from "../../../src/modules/infra/aws/ecr-scaled-job-reader";

export const readerConfig: AwsEcrScaledJobReaderConfig = {
  accountId: "123456789012", region: "eu-central-1", namespace: "runners",
  serviceAccount: "registry-reader", readerRole: "registry-reader",
  codeConfigMapName: "registry-reader", credentialsPath: "/run/registry",
  roleSessionName: "runner-registry-reader", errorLabel: "Runner",
};

export function readerResources(config = readerConfig, change?: (resource: any) => void): any[] {
  const chart = Testing.chart();
  const resource: any = {
    apiVersion: "keda.sh/v1alpha1", kind: "ScaledJob", metadata: { name: "selected-runner", namespace: "runners" },
    spec: { rollout: { strategy: "gradual" }, jobTargetRef: { activeDeadlineSeconds: 10800, template: {
      metadata: { annotations: { "keep.example.test/value": "unchanged" } },
      spec: { securityContext: { fsGroup: 1000 }, containers: [{ name: "runner", image: "example.test/runner:pinned",
        volumeMounts: [{ name: "docker", mountPath: "/docker" }] }], volumes: [{ name: "docker", emptyDir: {} }] },
    } } },
  };
  change?.(resource);
  const job = new ScaledJob(chart, "job", resource);
  addAwsEcrScaledJobReader(chart, job, config);
  return Testing.synth(chart);
}
