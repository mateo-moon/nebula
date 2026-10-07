import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import {
  CompositeResourceDefinitionV2, CompositeResourceDefinitionV2SpecScope,
  Composition, CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";

export const WORKER_EIP_PLACEHOLDER = "__NEBULA_WORKER_EIP_ALLOCATION_ID__";
export const WORKER_VOLUME_PLACEHOLDER = "__NEBULA_WORKER_EBS_VOLUME_ID__";

/** Named resource observations supply cloud-assigned IDs. No AWS lookup or
 * credentials are required in the composition function. On a transient loss
 * of observations, retain the previous LT desired state: omitting an already
 * composed resource would ask Crossplane to delete it. */
export const WORKER_LAUNCH_TEMPLATE = `
{{- $spec := .observed.composite.resource.spec }}
{{- $resources := .observed.resources | default dict }}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" }}
{{- range $key, $kind := dict "eip" "EIP" "data-volume" "EBSVolume" }}
{{- $name := $spec.eipName }}
{{- if eq $key "data-volume" }}{{ $name = $spec.dataVolumeName | default "" }}{{ end }}
{{- if $name }}
{{- $observer := dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation $key))
  "spec" (dict "managementPolicies" (list "Observe")
    "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" $kind "metadata" (dict "name" $name)))) }}
---
{{ $observer | toJson }}
{{- end }}
{{- end }}
{{- $eip := dig "resource" "status" "atProvider" "manifest" (dict) (get $resources "eip" | default dict) }}
{{- $volume := dig "resource" "status" "atProvider" "manifest" (dict) (get $resources "data-volume" | default dict) }}
{{- $allocation := dig "status" "atProvider" "id" "" $eip }}
{{- $volumeId := dig "status" "atProvider" "id" "" $volume }}
{{- $region := $spec.launchTemplate.spec.forProvider.region }}
{{- $ready := and (regexMatch "^eipalloc-[0-9a-f]+$" $allocation)
  (eq (dig "metadata" "name" "" $eip) $spec.eipName)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $eip) $allocation)
  (eq (dig "status" "atProvider" "allocationId" "" $eip) $allocation)
  (eq (dig "spec" "forProvider" "region" "" $eip) $region)
  (eq (dig "status" "atProvider" "region" "" $eip) $region) }}
{{- if $spec.dataVolumeName }}
{{- $ready = and $ready (regexMatch "^vol-[0-9a-f]+$" $volumeId)
  (eq (dig "metadata" "name" "" $volume) $spec.dataVolumeName)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $volume) $volumeId)
  (eq (dig "spec" "forProvider" "region" "" $volume) $region)
  (eq (dig "status" "atProvider" "region" "" $volume) $region)
  (eq (dig "spec" "forProvider" "availabilityZone" "" $volume) $spec.availabilityZone)
  (eq (dig "status" "atProvider" "availabilityZone" "" $volume) $spec.availabilityZone) }}
{{- end }}
{{- $template := dict }}
{{- if $ready }}
{{- $template = deepCopy $spec.launchTemplate }}
{{- $script := $template.spec.forProvider.userData | b64dec | replace "${WORKER_EIP_PLACEHOLDER}" $allocation }}
{{- if $spec.dataVolumeName }}{{ $script = $script | replace "${WORKER_VOLUME_PLACEHOLDER}" $volumeId }}{{ end }}
{{- $_ := set $template.spec.forProvider "userData" ($script | b64enc) }}
{{- else }}
{{- $previous := dig "resource" (dict) (get $resources "launch-template" | default dict) }}
{{- if and $previous (eq (dig "metadata" "name" "" $previous) $spec.launchTemplate.metadata.name) }}
{{- $template = dict "apiVersion" $previous.apiVersion "kind" $previous.kind
  "metadata" (dict "name" $previous.metadata.name) "spec" $previous.spec }}
{{- end }}
{{- end }}
{{- if $template }}
{{- $annotations := get $template.metadata "annotations" | default dict }}
{{- $_ := set $annotations $annotation "launch-template" }}
{{- $_ := set $template.metadata "annotations" $annotations }}
---
{{ $template | toJson }}
{{- end }}
`.trim();

/** Install once on management before enabling observed worker identities.
 * provider-kubernetes needs read access to EIP and EBSVolume resources. */
export class AwsWorkerLaunchTemplateSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: { name: "xawsworkerlaunchtemplates.nebula.io", annotations: { "argocd.argoproj.io/sync-wave": "-10" } },
      spec: {
        group: "nebula.io", names: { kind: "XAwsWorkerLaunchTemplate", plural: "xawsworkerlaunchtemplates" },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [{ name: "v1alpha1", served: true, referenceable: true, schema: { openApiv3Schema: {
          type: "object", properties: { spec: {
            type: "object", required: ["eipName", "availabilityZone", "kubeProviderConfigName", "launchTemplate"],
            properties: {
              eipName: { type: "string", minLength: 1 },
              dataVolumeName: { type: "string", minLength: 1 },
              availabilityZone: { type: "string", minLength: 1 },
              kubeProviderConfigName: { type: "string", minLength: 1 },
              launchTemplate: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
            },
          } },
        } } }],
      },
    });
    this.composition = new Composition(this, "composition", {
      metadata: { name: "aws-worker-launch-template", annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: {
        compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XAwsWorkerLaunchTemplate" },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "observe-and-render", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline",
          inline: { template: WORKER_LAUNCH_TEMPLATE },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}

export interface AwsWorkerLaunchTemplateConfig {
  eipName: string;
  dataVolumeName?: string;
  availabilityZone: string;
  kubeProviderConfigName?: string;
  /** The complete desired LT MR. The fleet supplies a checked bootstrap
   * template containing the two placeholders substituted by the composition. */
  launchTemplate: Record<string, any>;
}

export class AwsWorkerLaunchTemplate extends Construct {
  public readonly xr: ApiObject;
  constructor(scope: Construct, id: string, config: AwsWorkerLaunchTemplateConfig) {
    super(scope, id);
    if (config.launchTemplate.kind !== "LaunchTemplate" ||
        config.launchTemplate.apiVersion !== "ec2.aws.upbound.io/v1beta1")
      throw new Error("Observed worker bootstrap requires an AWS LaunchTemplate managed resource");
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1", kind: "XAwsWorkerLaunchTemplate",
      metadata: { name: config.launchTemplate.metadata.name },
      spec: {
        crossplane: { compositionRef: { name: "aws-worker-launch-template" } },
        ...config,
        kubeProviderConfigName: config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}
