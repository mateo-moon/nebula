/** Inline fragment for the worker composition. The caller supplies $spec,
 * $resources, $region, $annotation and $observers, then folds $networkReady into
 * its binding gate before emitting observers. Populate the atomic LT network
 * interface with $securityGroupId as well as its existing named reference. */
export const WORKER_NETWORK_OBSERVATION = String.raw`
{{- $securityGroupName := $spec.securityGroupName | default "" -}}
{{- $groupObserver := dig "resource" (dict) (get $resources "security-group" | default dict) -}}
{{- $group := dig "status" "atProvider" "manifest" (dict) $groupObserver -}}
{{- $securityGroupId := dig "status" "atProvider" "id" "" $group -}}
{{- $observerReady := false -}}{{- $observerSynced := false -}}
{{- $groupReady := false -}}{{- $groupSynced := false -}}
{{- range (dig "status" "conditions" (list) $groupObserver) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $observerReady = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $observerSynced = true -}}
{{- if hasKey . "observedGeneration" -}}{{- $observerSynced = eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $groupObserver)) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- range (dig "status" "conditions" (list) $group) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $groupReady = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $groupSynced = true -}}
{{- if hasKey . "observedGeneration" -}}{{- $groupSynced = eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $group)) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- $networkReady := and (ne $securityGroupName "") $observerReady $observerSynced $groupReady $groupSynced
  (not (dig "metadata" "deletionTimestamp" "" $group))
  (eq (dig "apiVersion" "" $group) "ec2.aws.upbound.io/v1beta1") (eq (dig "kind" "" $group) "SecurityGroup")
  (eq (dig "metadata" "name" "" $group) $securityGroupName)
  (regexMatch "^sg-[0-9a-f]{8}([0-9a-f]{9})?$" $securityGroupId)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $group) $securityGroupId)
  (eq (dig "spec" "providerConfigRef" "name" "" $group) $spec.launchTemplate.spec.providerConfigRef.name)
  (eq (dig "spec" "forProvider" "region" "" $group) $region)
  (eq (dig "status" "atProvider" "region" "" $group) $region) -}}
{{- $desiredVpc := dig "spec" "forProvider" "vpcId" "" $group -}}
{{- if $desiredVpc -}}
{{- $networkReady = and $networkReady (eq $desiredVpc (dig "status" "atProvider" "vpcId" "" $group)) -}}
{{- end -}}
{{- if $securityGroupName -}}
{{- $observers = append $observers (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation "security-group"))
  "spec" (dict "managementPolicies" (list "Observe")
    "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "SecurityGroup" "metadata" (dict "name" $securityGroupName))))) -}}
{{- end -}}
`.trim();
