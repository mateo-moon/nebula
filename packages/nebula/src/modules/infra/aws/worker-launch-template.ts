import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import { WORKER_NETWORK_OBSERVATION } from "./worker-network-observation";
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
{{- define "worker.ready" -}}
{{- $ready := false -}}{{- $synced := false -}}{{- $object := . -}}
{{- range (dig "status" "conditions" (list) $object) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $ready = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $synced = true -}}
{{- if hasKey . "observedGeneration" -}}{{- $synced = eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $object)) -}}{{- end -}}
{{- end -}}{{- end -}}
{{- and $ready $synced (not (dig "metadata" "deletionTimestamp" "" $object)) -}}
{{- end }}
{{- $xr := .observed.composite.resource }}
{{- $spec := $xr.spec }}
{{- $resources := .observed.resources | default dict }}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" }}
{{- $observers := list }}
{{- $region := $spec.launchTemplate.spec.forProvider.region }}
{{- $handoff := $spec.handoff | default "" }}
{{- $xrUID := dig "metadata" "uid" "" $xr }}
{{- range $key, $kind := dict "eip" "EIP" "data-volume" "EBSVolume" "adoption-source" "LaunchTemplate" }}
{{- $name := $spec.eipName }}
{{- if eq $key "data-volume" }}{{ $name = $spec.dataVolumeName | default "" }}{{ end }}
{{- if eq $key "adoption-source" }}{{ $name = ternary $spec.launchTemplate.metadata.name "" (ne $handoff "") }}{{ end }}
{{- if $name }}
{{- $observers = append $observers (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation $key))
  "spec" (dict "managementPolicies" (list "Observe")
    "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" $kind "metadata" (dict "name" $name))))) }}
{{- end }}
{{- end }}
${WORKER_NETWORK_OBSERVATION}
{{- $interfaces := dig "spec" "forProvider" "networkInterfaces" (list) $spec.launchTemplate }}
{{- $networkShapeReady := eq (len $interfaces) 1 }}
{{- if $networkShapeReady }}
{{- $references := get (index $interfaces 0) "securityGroupRefs" | default list }}
{{- $networkShapeReady = eq (len $references) 1 }}
{{- if $networkShapeReady }}{{ $networkShapeReady = eq ((index $references 0).name | default "") $spec.securityGroupName }}{{ end }}
{{- end }}
{{- $networkReady = and $networkReady $networkShapeReady }}
{{- $eipObserver := dig "resource" (dict) (get $resources "eip" | default dict) }}
{{- $volumeObserver := dig "resource" (dict) (get $resources "data-volume" | default dict) }}
{{- $eip := dig "status" "atProvider" "manifest" (dict) $eipObserver }}
{{- $volume := dig "status" "atProvider" "manifest" (dict) $volumeObserver }}
{{- $allocation := dig "status" "atProvider" "id" "" $eip }}
{{- $volumeId := dig "status" "atProvider" "id" "" $volume }}
{{- $ready := and $networkReady (eq (include "worker.ready" $eipObserver) "true") (eq (include "worker.ready" $eip) "true")
  (regexMatch "^eipalloc-[0-9a-f]+$" $allocation)
  (eq (dig "metadata" "name" "" $eip) $spec.eipName)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $eip) $allocation)
  (eq (dig "status" "atProvider" "allocationId" "" $eip) $allocation)
  (eq (dig "spec" "providerConfigRef" "name" "" $eip) $spec.launchTemplate.spec.providerConfigRef.name)
  (eq (dig "spec" "forProvider" "region" "" $eip) $region)
  (eq (dig "status" "atProvider" "region" "" $eip) $region) }}
{{- if $spec.dataVolumeName }}
{{- $ready = and $ready (eq (include "worker.ready" $volumeObserver) "true") (eq (include "worker.ready" $volume) "true")
  (regexMatch "^vol-[0-9a-f]+$" $volumeId)
  (eq (dig "metadata" "name" "" $volume) $spec.dataVolumeName)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $volume) $volumeId)
  (eq (dig "spec" "providerConfigRef" "name" "" $volume) $spec.launchTemplate.spec.providerConfigRef.name)
  (eq (dig "spec" "forProvider" "region" "" $volume) $region)
  (eq (dig "status" "atProvider" "region" "" $volume) $region)
  (eq (dig "spec" "forProvider" "availabilityZone" "" $volume) $spec.availabilityZone)
  (eq (dig "status" "atProvider" "availabilityZone" "" $volume) $spec.availabilityZone) }}
{{- end }}
{{- $previous := dig "resource" (dict) (get $resources "launch-template" | default dict) }}
{{- $previousOwned := false }}
{{- range (dig "metadata" "ownerReferences" (list) $previous) }}
{{- if and .controller (ne $xrUID "") (eq .uid $xrUID) (eq .kind $xr.kind) (eq .name $xr.metadata.name) }}{{ $previousOwned = true }}{{ end }}
{{- end }}
{{- $previousOwned = and $previousOwned (eq (dig "metadata" "name" "" $previous) $spec.launchTemplate.metadata.name)
  (eq (dig "apiVersion" "" $previous) "ec2.aws.upbound.io/v1beta1") (eq (dig "kind" "" $previous) "LaunchTemplate")
  (not (dig "metadata" "deletionTimestamp" "" $previous)) }}
{{- $currentTemplateGeneration := false }}
{{- range (dig "status" "conditions" (list) $previous) }}
{{- if and (eq .type "Synced") (eq .status "True") (hasKey . "observedGeneration")
  (gt (int (dig "metadata" "generation" 0 $previous)) 0)
  (eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $previous))) }}{{ $currentTemplateGeneration = true }}{{ end }}
{{- end }}
{{- $templateReady := and $previousOwned $currentTemplateGeneration (eq (include "worker.ready" $previous) "true") }}
{{- $baseline := deepCopy (dig "status" "handoff" (dict) $xr) }}
{{- $ownershipReady := $previousOwned }}
{{- $source := dict }}
{{- if $handoff }}
{{- $sourceObserver := dig "resource" (dict) (get $resources "adoption-source" | default dict) }}
{{- $source = dig "status" "atProvider" "manifest" (dict) $sourceObserver }}
{{- $sourceUID := dig "metadata" "uid" "" $source }}
{{- $sourceID := dig "metadata" "annotations" "crossplane.io/external-name" "" $source }}
{{- $sourceReady := and (eq (include "worker.ready" $sourceObserver) "true") (eq (include "worker.ready" $source) "true")
  (eq (dig "apiVersion" "" $source) "ec2.aws.upbound.io/v1beta1") (eq (dig "kind" "" $source) "LaunchTemplate")
  (ne $sourceUID "") (regexMatch "^lt-[0-9a-f]+$" $sourceID)
  (eq (dig "metadata" "name" "" $source) $spec.launchTemplate.metadata.name)
  (eq (dig "spec" "forProvider" "name" "" $source) $spec.launchTemplate.metadata.name)
  (eq (dig "status" "atProvider" "name" "" $source) $spec.launchTemplate.metadata.name)
  (eq (dig "status" "atProvider" "id" "" $source) $sourceID)
  (eq (dig "spec" "forProvider" "region" "" $source) $region)
  (eq (dig "status" "atProvider" "region" "" $source) $region)
  (eq (dig "spec" "providerConfigRef" "name" "" $source) $spec.launchTemplate.spec.providerConfigRef.name) }}
{{- range (dig "metadata" "ownerReferences" (list) $source) }}
{{- if and .controller (or (ne .uid $xrUID) (ne .kind $xr.kind) (ne .name $xr.metadata.name)) }}{{ $sourceReady = false }}{{ end }}
{{- end }}
{{- if and (eq $handoff "retain") $sourceReady (not $baseline) }}
{{- $baseline = dict "uid" $sourceUID "externalName" $sourceID }}
{{- end }}
{{- $baselineMatches := and (not (empty $baseline)) (eq ($baseline.uid | default "") $sourceUID) (eq ($baseline.externalName | default "") $sourceID) }}
{{- $ownershipReady = and $previousOwned $baselineMatches
  (eq (dig "metadata" "uid" "" $previous) ($baseline.uid | default ""))
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $previous) ($baseline.externalName | default ""))
  (eq (dig "status" "atProvider" "id" "" $previous) ($baseline.externalName | default "")) }}
{{- $ready = and $ready $sourceReady $baselineMatches }}
{{- end }}
{{- $template := dict }}
{{- $activate := and (eq $handoff "activate") $ready $ownershipReady $templateReady }}
{{- if and (eq $handoff "retain") $ready }}
{{- $template = dict "apiVersion" $source.apiVersion "kind" $source.kind "metadata" (dict "name" $source.metadata.name) "spec" (deepCopy $source.spec) }}
{{- $_ := set $template.spec "deletionPolicy" "Orphan" }}
{{- $_ := set $template.spec "managementPolicies" (list "Observe" "Update" "LateInitialize") }}
{{- $_ := set $template.metadata "annotations" (dict "argocd.argoproj.io/sync-options" "Prune=false,Delete=false" "argocd.argoproj.io/compare-options" "IgnoreExtraneous") }}
{{- else if or (and (not $handoff) $ready) $activate }}
{{- $template = deepCopy $spec.launchTemplate }}
{{- $script := $template.spec.forProvider.userData | b64dec | replace "${WORKER_EIP_PLACEHOLDER}" $allocation }}
{{- if $spec.dataVolumeName }}{{ $script = $script | replace "${WORKER_VOLUME_PLACEHOLDER}" $volumeId }}{{ end }}
{{- $_ := set $template.spec.forProvider "userData" ($script | b64enc) }}
{{- range $template.spec.forProvider.networkInterfaces }}{{ $_ := set . "securityGroups" (list $securityGroupId) }}{{ end }}
{{- if $activate }}
{{- $_ := set $template.spec "deletionPolicy" "Delete" }}
{{- $_ := set $template.spec "managementPolicies" (list "Observe" "Update" "Delete" "LateInitialize") }}
{{- $annotations := get $template.metadata "annotations" | default dict }}
{{- range list "argocd.argoproj.io/tracking-id" "argocd.argoproj.io/sync-options" "argocd.argoproj.io/compare-options" "argocd.argoproj.io/sync-wave" }}{{ $_ := set $annotations . "" }}{{ end }}
{{- $_ := set $template.metadata "annotations" $annotations }}
{{- end }}
{{- else if $previousOwned }}
{{- $annotations := dict }}
{{- range $key, $value := ($previous.metadata.annotations | default dict) }}
{{- if or (hasPrefix "argocd.argoproj.io/" $key) (hasKey ($spec.launchTemplate.metadata.annotations | default dict) $key) }}{{ $_ := set $annotations $key $value }}{{ end }}
{{- end }}
{{- $template = dict "apiVersion" $previous.apiVersion "kind" $previous.kind
  "metadata" (dict "name" $previous.metadata.name "annotations" $annotations) "spec" $previous.spec }}
{{- end }}
{{- $guardsReady := and $ready $templateReady (or (not $handoff) $ownershipReady) }}
{{- range $observers }}
{{- if not $guardsReady }}{{ $_ := set .metadata.annotations "gotemplating.fn.crossplane.io/ready" "False" }}{{ end }}
---
{{ . | toJson }}
{{- end }}
{{- if $template }}
{{- $annotations := get $template.metadata "annotations" | default dict }}
{{- $_ := set $annotations $annotation "launch-template" }}
{{- if not $guardsReady }}{{ $_ := set $annotations "gotemplating.fn.crossplane.io/ready" "False" }}{{ end }}
{{- $_ := set $template.metadata "annotations" $annotations }}
---
{{ $template | toJson }}
{{- end }}
---
{{ dict "apiVersion" $xr.apiVersion "kind" $xr.kind "metadata" (dict "name" $xr.metadata.name)
  "status" (dict "bindingsReady" $ready "ownershipReady" $ownershipReady "launchTemplateReady" $templateReady "handoff" $baseline "handoffActive" $activate) | toJson }}
`.trim();

/** Install once on management before enabling observed worker identities.
 * provider-kubernetes needs read access to EIP, EBSVolume, SecurityGroup and
 * LaunchTemplate resources. Observers never write those resources. */
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
            type: "object", required: ["eipName", "securityGroupName", "availabilityZone", "kubeProviderConfigName", "launchTemplate"],
            "x-kubernetes-validations": [{
              rule: "!has(oldSelf.handoff) || (has(self.handoff) && (oldSelf.handoff != 'activate' || self.handoff == 'activate'))",
              message: "An existing-resource handoff cannot be removed or reverted after activation",
            }],
            properties: {
              eipName: { type: "string", minLength: 1 },
              securityGroupName: { type: "string", minLength: 1 },
              dataVolumeName: { type: "string", minLength: 1 },
              handoff: { type: "string", enum: ["retain", "activate"] },
              availabilityZone: { type: "string", minLength: 1 },
              kubeProviderConfigName: { type: "string", minLength: 1 },
              launchTemplate: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
            },
          }, status: { type: "object", properties: {
            bindingsReady: { type: "boolean" }, ownershipReady: { type: "boolean" }, launchTemplateReady: { type: "boolean" }, handoffActive: { type: "boolean" },
            handoff: { type: "object", properties: { uid: { type: "string" }, externalName: { type: "string" } } },
          } } },
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
  /** Observe the security group so SSA preserves the provider-resolved atomic
   * network-interface array. Must match the LT's one named SG reference. */
  securityGroupName: string;
  dataVolumeName?: string;
  /** Existing-resource handoff: retain first; activate only after its same UID,
   * cloud binding and XR controller owner are observed. Omit for fresh workers. */
  handoff?: "retain" | "activate";
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
    const interfaces = config.launchTemplate.spec?.forProvider?.networkInterfaces;
    if (!Array.isArray(interfaces) || interfaces.length !== 1 ||
        interfaces[0].securityGroupRefs?.length !== 1 ||
        interfaces[0].securityGroupRefs[0].name !== config.securityGroupName)
      throw new Error("Observed worker bootstrap requires one network interface with its named security-group reference");
    if (config.launchTemplate.metadata?.annotations?.["crossplane.io/external-name"] !== undefined)
      throw new Error("The launch-template cloud binding must remain provider-owned");
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1", kind: "XAwsWorkerLaunchTemplate",
      metadata: {
        name: config.launchTemplate.metadata.name,
        ...(config.handoff === "retain" ? { annotations: { "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } } : {}),
      },
      spec: {
        crossplane: { compositionRef: { name: "aws-worker-launch-template" } },
        ...config,
        kubeProviderConfigName: config.kubeProviderConfigName ?? "kubernetes-provider-config",
      },
    });
  }
}
