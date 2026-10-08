import { OWNED_RESOURCE_ACKNOWLEDGEMENT } from "../owned-resource-acknowledgement";

/** CAPA supplies NAT addresses; staged adoption preserves existing rules until
 * their controller ownership and retained cloud bindings have been observed. */
export const CLUSTER_NAT_INGRESS_TEMPLATE = String.raw`
${OWNED_RESOURCE_ACKNOWLEDGEMENT}
{{- define "emit" }}
---
{{ . | toJson }}
{{ end -}}
{{- define "nat.ready" -}}
{{- $ready := false -}}{{- $synced := false -}}{{- $object := . -}}
{{- range (dig "status" "conditions" (list) $object) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $ready = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $synced = true -}}
{{- if hasKey . "observedGeneration" -}}{{- $synced = eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $object)) -}}{{- end -}}
{{- end -}}{{- end -}}
{{- and $ready $synced (not (dig "metadata" "deletionTimestamp" "" $object)) -}}
{{- end -}}
{{- define "nat.owned" -}}
{{- $owned := false -}}{{- $xr := .xr -}}
{{- range (dig "metadata" "ownerReferences" (list) .rule) -}}
{{- if and (.controller | default false) (ne (dig "metadata" "uid" "" $xr) "") (eq .uid $xr.metadata.uid) (eq .kind $xr.kind) (eq .name $xr.metadata.name) -}}{{- $owned = true -}}{{- end -}}
{{- end -}}{{- $owned -}}
{{- end -}}
{{- define "nat.identity" -}}
{{- $rule := .rule -}}{{- $spec := .spec -}}{{- $for := dig "spec" "forProvider" (dict) $rule -}}
{{- $at := dig "status" "atProvider" (dict) $rule -}}{{- $id := dig "metadata" "annotations" "crossplane.io/external-name" "" $rule -}}
{{- $ready := and (not (dig "metadata" "deletionTimestamp" "" $rule))
  (eq (dig "apiVersion" "" $rule) "ec2.aws.upbound.io/v1beta1") (eq (dig "kind" "" $rule) "SecurityGroupIngressRule")
  (eq (dig "metadata" "name" "" $rule) .name) (ne (dig "metadata" "uid" "" $rule) "")
  (regexMatch "^sgr-[0-9a-f]+$" $id) (eq (get $at "id") $id) (eq (get $at "securityGroupRuleId") $id)
  (eq (get $for "region") $spec.region) (eq (get $at "region") $spec.region)
  (eq (dig "spec" "providerConfigRef" "name" "" $rule) $spec.awsProviderConfigName)
  (eq (dig "securityGroupIdRef" "name" "" $for) $spec.securityGroupName)
  (regexMatch "^sg-[0-9a-f]+$" (get $for "securityGroupId" | default ""))
  (eq (get $for "securityGroupId") (get $at "securityGroupId"))
  (eq (get $for "ipProtocol") $spec.ipProtocol) (eq (get $at "ipProtocol") $spec.ipProtocol)
  (eq (toString (get $for "fromPort")) (toString $spec.fromPort)) (eq (toString (get $at "fromPort")) (toString $spec.fromPort))
  (eq (toString (get $for "toPort")) (toString $spec.toPort)) (eq (toString (get $at "toPort")) (toString $spec.toPort))
  (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$" (get $for "cidrIpv4" | default ""))
  (eq (get $for "cidrIpv4") (get $at "cidrIpv4")) -}}
{{- range (dig "metadata" "ownerReferences" (list) $rule) -}}
{{- if and (.controller | default false) (or (ne .uid $.xr.metadata.uid) (ne .kind $.xr.kind) (ne .name $.xr.metadata.name)) -}}{{- $ready = false -}}{{- end -}}
{{- end -}}{{- $ready -}}
{{- end -}}
{{- define "nat.rule" -}}
{{- and (eq (include "nat.ready" .rule) "true") (eq (include "nat.identity" .) "true") -}}
{{- end -}}
{{- define "nat.retiring" -}}
{{- and (eq (.spec.deletionPolicy | default "") "Delete")
  (eq (join "," (sortAlpha (uniq (.spec.managementPolicies | default list)))) "Delete,Observe") -}}
{{- end -}}
{{- $xr := .observed.composite.resource -}}{{- $spec := $xr.spec -}}
{{- $resources := .observed.resources | default dict -}}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" -}}
{{- $readyAnnotation := "gotemplating.fn.crossplane.io/ready" -}}
{{- $handoff := $spec.handoff | default "" -}}
{{- $baseline := deepCopy (dig "status" "handoff" (dict) $xr) -}}
{{- $adoptionComplete := dig "status" "adoptionComplete" false $xr -}}
{{- $clusterObserver := dig "resource" (dict) (get $resources "cluster" | default dict) -}}
{{- $cluster := dig "status" "atProvider" "manifest" (dict) $clusterObserver -}}
{{- $ips := dig "status" "networkStatus" "natGatewaysIPs" (list) $cluster -}}
{{- $valid := and (eq (include "nat.ready" $clusterObserver) "true")
  (eq (dig "apiVersion" "" $cluster) "infrastructure.cluster.x-k8s.io/v1beta2") (eq (dig "kind" "" $cluster) "AWSCluster")
  (eq (dig "metadata" "name" "" $cluster) $spec.awsClusterName) (eq (dig "metadata" "namespace" "" $cluster) $spec.awsClusterNamespace)
  (not (dig "metadata" "deletionTimestamp" "" $cluster)) (eq (dig "spec" "region" "" $cluster) $spec.awsClusterRegion)
  (dig "status" "ready" false $cluster) (kindIs "slice" $ips) -}}
{{- if hasKey ($cluster.status | default dict) "observedGeneration" -}}
{{- $valid = and $valid (eq (toString $cluster.status.observedGeneration) (toString (dig "metadata" "generation" 0 $cluster))) -}}
{{- end -}}
{{- $wanted := dict -}}
{{- if $valid -}}
{{- $valid = and (ge (len $ips) 1) (le (len $ips) 32) -}}
{{- range $ip := $ips -}}
{{- if not (kindIs "string" $ip) -}}{{- $valid = false -}}
{{- else -}}
{{- if or (not (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}$" $ip)) (hasKey $wanted $ip) -}}{{- $valid = false -}}{{- end -}}
{{- range $octet := splitList "." $ip -}}
{{- if or (gt (int $octet) 255) (ne (toString (int $octet)) $octet) -}}{{- $valid = false -}}{{- end -}}
{{- end -}}
{{- if or (hasPrefix "0." $ip) (hasPrefix "127." $ip) (eq $ip "255.255.255.255") -}}{{- $valid = false -}}{{- end -}}
{{- $_ := set $wanted $ip true -}}
{{- end -}}{{- end -}}{{- end -}}
{{- $observers := list -}}{{- $sources := dict -}}{{- $known := dict -}}{{- $owned := dict -}}
{{- $identityVerified := dict -}}{{- $retirementIntent := dict -}}
{{- $sourceReady := true -}}{{- $ownershipReady := true -}}{{- $rulesReady := true -}}{{- $detached := true -}}
{{- if not $adoptionComplete -}}
{{- range $name := $spec.existingRuleNames -}}
{{- $observer := dig "resource" (dict) (get $resources (printf "existing-%s" $name) | default dict) -}}
{{- $rule := dig "status" "atProvider" "manifest" (dict) $observer -}}
{{- $matches := and (eq (include "nat.ready" $observer) "true") (eq (include "nat.rule" (dict "rule" $rule "spec" $spec "name" $name "xr" $xr)) "true") -}}
{{- if and $matches (eq $handoff "retain") (not (hasKey $baseline $name)) -}}
{{- $_ := set $baseline $name (dict "uid" $rule.metadata.uid "externalName" (get $rule.metadata.annotations "crossplane.io/external-name")) -}}
{{- end -}}
{{- $saved := get $baseline $name | default dict -}}
{{- $matches = and $matches (eq (dig "metadata" "uid" "" $rule) (get $saved "uid" | default "missing"))
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $rule) (get $saved "externalName" | default "missing")) -}}
{{- if $matches -}}{{- $_ := set $sources $name $rule -}}{{- else -}}{{- $sourceReady = false -}}{{- end -}}
{{- $observers = append $observers (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation (printf "existing-%s" $name)))
  "spec" (dict "managementPolicies" (list "Observe") "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "SecurityGroupIngressRule" "metadata" (dict "name" $name))))) -}}
{{- end -}}
{{- end -}}
{{- range $key, $value := $resources -}}
{{- if hasPrefix "rule-" $key -}}
{{- $rule := $value.resource -}}{{- $name := dig "metadata" "name" "" $rule -}}
{{- $isOwned := and (eq (printf "rule-%s" $name) $key) (eq (include "nat.owned" (dict "rule" $rule "xr" $xr)) "true") -}}
{{- if $isOwned -}}
{{- $_ := set $owned $name $rule -}}
{{- $identity := eq (include "nat.identity" (dict "rule" $rule "spec" $spec "name" $name "xr" $xr)) "true" -}}
{{- if hasKey $baseline $name -}}
{{- $saved := get $baseline $name -}}
{{- $identity = and $identity (eq $rule.metadata.uid ($saved.uid | default ""))
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $rule) ($saved.externalName | default "")) -}}
{{- else -}}
{{- $ip := dig "spec" "forProvider" "cidrIpv4" "" $rule | trimSuffix "/32" -}}
{{- $identity = and $identity (not (has $name $spec.existingRuleNames))
  (eq $name (printf "%s-%s" $spec.name ($ip | sha256sum | trunc 12))) -}}
{{- end -}}
{{- $_ := set $identityVerified $name $identity -}}
{{- $acknowledgement := include "owned.acknowledgement" (dict "observed" $rule "identityVerified" $identity) | fromJson -}}
{{- $_ := set $retirementIntent $name (and (hasKey $baseline $name) $acknowledgement.retiring) -}}
{{- if $acknowledgement.hold -}}{{- $rulesReady = false -}}{{- end -}}
{{- $currentGeneration := false -}}
{{- range (dig "status" "conditions" (list) $rule) -}}
{{- if and (eq .type "Synced") (eq .status "True") (hasKey . "observedGeneration")
  (gt (int (dig "metadata" "generation" 0 $rule)) 0)
  (eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $rule))) -}}{{- $currentGeneration = true -}}{{- end -}}
{{- end -}}
{{- $matches := and $currentGeneration (not $acknowledgement.hold) (eq (include "nat.rule" (dict "rule" $rule "spec" $spec "name" $name "xr" $xr)) "true") -}}
{{- if hasKey $baseline $name -}}
{{- $saved := get $baseline $name -}}
{{- $matches = and $matches (eq $rule.metadata.uid $saved.uid) (eq (get $rule.metadata.annotations "crossplane.io/external-name") $saved.externalName) -}}
{{- end -}}
{{- if $matches -}}{{- $_ := set $known $name $rule -}}{{- else -}}{{- $rulesReady = false -}}{{- end -}}
{{- else -}}{{- $rulesReady = false -}}{{- end -}}
{{- end -}}{{- end -}}
{{- range $name := $spec.existingRuleNames -}}
{{- $current := get $known $name | default dict -}}
{{- if not $current -}}{{- $ownershipReady = false -}}{{- $detached = false -}}
{{- else -}}
{{- range list "argocd.argoproj.io/tracking-id" "argocd.argoproj.io/sync-options" "argocd.argoproj.io/compare-options" "argocd.argoproj.io/sync-wave" -}}
{{- if ne (dig "metadata" "annotations" . "unresolved" $current) "" -}}{{- $detached = false -}}{{- end -}}
{{- end -}}
{{- if or (ne $current.spec.deletionPolicy "Orphan")
  (ne (join "," (sortAlpha (uniq ($current.spec.managementPolicies | default list)))) "LateInitialize,Observe,Update") -}}{{- $detached = false -}}{{- end -}}
{{- end -}}{{- end -}}
{{- if and (eq $handoff "activate") $sourceReady $ownershipReady $rulesReady $detached -}}{{- $adoptionComplete = true -}}{{- end -}}
{{- $valid = and $valid $rulesReady (or (not $handoff) $adoptionComplete $sourceReady) -}}
{{- $activate := and (eq $handoff "activate") $valid (or $adoptionComplete $ownershipReady) -}}
{{- $desired := dict -}}{{- $policyPending := false -}}
{{- if and (eq $handoff "retain") $valid -}}
{{- range $name, $source := $sources -}}
{{- $rule := dict "apiVersion" $source.apiVersion "kind" $source.kind "metadata" (dict "name" $name "annotations" (dict
  "argocd.argoproj.io/sync-options" "Prune=false,Delete=false" "argocd.argoproj.io/compare-options" "IgnoreExtraneous")) "spec" (deepCopy $source.spec) -}}
{{- $_ := set $rule.spec "deletionPolicy" "Orphan" -}}{{- $_ := set $rule.spec "managementPolicies" (list "Observe" "Update" "LateInitialize") -}}
{{- $_ := set $desired $name $rule -}}
{{- end -}}
{{- else if and $activate (not $adoptionComplete) -}}
{{- /* Detach every baseline before changing the source set. */ -}}
{{- range $name := $spec.existingRuleNames -}}
{{- $source := get $known $name -}}{{- $ruleSpec := deepCopy $source.spec -}}
{{- $_ := set $ruleSpec "deletionPolicy" "Orphan" -}}{{- $_ := set $ruleSpec "managementPolicies" (list "Observe" "Update" "LateInitialize") -}}
{{- $annotations := dict -}}
{{- range list "argocd.argoproj.io/tracking-id" "argocd.argoproj.io/sync-options" "argocd.argoproj.io/compare-options" "argocd.argoproj.io/sync-wave" -}}{{- $_ := set $annotations . "" -}}{{- end -}}
{{- $_ := set $desired $name (dict "apiVersion" $source.apiVersion "kind" $source.kind "metadata" (dict "name" $name "annotations" $annotations) "spec" $ruleSpec) -}}
{{- end -}}
{{- else if or (and (not $handoff) $valid) $activate -}}
{{- $assignments := dict -}}{{- $used := dict -}}{{- $retiringIPs := dict -}}{{- $nameCollision := false -}}
{{- range $name := keys $known | sortAlpha -}}
{{- $previous := get $known $name -}}
{{- $ip := dig "spec" "forProvider" "cidrIpv4" "" $previous | trimSuffix "/32" -}}
{{- $retiring := get $retirementIntent $name | default false -}}
{{- if $retiring -}}
{{- /* Retirement is irreversible once the delete-only policy is observed.
      A returned source gets a fresh hashed rule only after this MR is gone. */ -}}
{{- $_ := set $retiringIPs $ip true -}}
{{- if ne (include "nat.retiring" $previous) "true" -}}
{{- /* A probe temporarily removes Delete. Never omit that rule until its
      actual delete-only policy and current acknowledgement are restored. */ -}}
{{- $_ := set $desired $name (include "owned.acknowledgement-preserve" (dict "observed" $previous) | fromJson) -}}
{{- $policyPending = true -}}
{{- end -}}
{{- else if and (hasKey $wanted $ip) (not (hasKey $used $ip)) -}}
{{- $_ := set $assignments $name $ip -}}{{- $_ := set $used $ip true -}}
{{- else if hasKey $baseline $name -}}
{{- /* Prepare revocation without mutating any cloud field. The strict owned
      generation gate must observe this supported policy before omission. */ -}}
{{- $retiringSpec := deepCopy $previous.spec -}}
{{- $policyPending = true -}}
{{- $_ := set $retiringSpec "deletionPolicy" "Delete" -}}
{{- $_ := set $retiringSpec "managementPolicies" (list "Observe" "Delete") -}}
{{- $annotations := dict -}}
{{- range list "argocd.argoproj.io/tracking-id" "argocd.argoproj.io/sync-options" "argocd.argoproj.io/compare-options" "argocd.argoproj.io/sync-wave" -}}{{- $_ := set $annotations . "" -}}{{- end -}}
{{- $_ := set $desired $name (dict "apiVersion" $previous.apiVersion "kind" $previous.kind "metadata" (dict "name" $name "annotations" $annotations) "spec" $retiringSpec) -}}
{{- end -}}{{- end -}}
{{- range $ip := keys $wanted | sortAlpha -}}
{{- if and (not (hasKey $used $ip)) (not (hasKey $retiringIPs $ip)) -}}
{{- $name := printf "%s-%s" $spec.name ($ip | sha256sum | trunc 12) -}}
{{- if or (hasKey $baseline $name) (hasKey $assignments $name)
  (and (hasKey $owned $name) (ne (dig "spec" "forProvider" "cidrIpv4" "" (get $owned $name)) (printf "%s/32" $ip))) -}}
{{- $nameCollision = true -}}
{{- else -}}
{{- $_ := set $assignments $name $ip -}}{{- $_ := set $used $ip true -}}
{{- end -}}
{{- end -}}{{- end -}}
{{- range $name, $ip := $assignments -}}
{{- $previous := get $known $name | default dict -}}
{{- $ruleSpec := deepCopy (get $previous "spec" | default dict) -}}
{{- $for := get $ruleSpec "forProvider" | default dict -}}
{{- $_ := set $for "region" $spec.region -}}{{- $_ := set $for "securityGroupIdRef" (dict "name" $spec.securityGroupName) -}}
{{- $_ := set $for "ipProtocol" $spec.ipProtocol -}}{{- $_ := set $for "fromPort" $spec.fromPort -}}{{- $_ := set $for "toPort" $spec.toPort -}}
{{- $_ := set $for "cidrIpv4" (printf "%s/32" $ip) -}}
{{- if not $previous -}}{{- $_ := set $for "description" $spec.description -}}{{- $_ := set $for "tags" (dict "Name" $name) -}}{{- end -}}
{{- $_ := set $ruleSpec "forProvider" $for -}}{{- $_ := set $ruleSpec "providerConfigRef" (dict "name" $spec.awsProviderConfigName) -}}
{{- $_ := set $ruleSpec "deletionPolicy" "Delete" -}}
{{- $policies := list "Observe" "Create" "Update" "Delete" "LateInitialize" -}}
{{- if hasKey $baseline $name -}}
{{- $_ := set $ruleSpec "deletionPolicy" "Orphan" -}}
{{- $policies = list "Observe" "Update" "LateInitialize" -}}
{{- end -}}
{{- $_ := set $ruleSpec "managementPolicies" $policies -}}
{{- $annotations := dict -}}
{{- if hasKey $baseline $name -}}
{{- range list "argocd.argoproj.io/tracking-id" "argocd.argoproj.io/sync-options" "argocd.argoproj.io/compare-options" "argocd.argoproj.io/sync-wave" -}}{{- $_ := set $annotations . "" -}}{{- end -}}
{{- end -}}
{{- $_ := set $desired $name (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "SecurityGroupIngressRule"
  "metadata" (dict "name" $name "annotations" $annotations) "spec" $ruleSpec) -}}
{{- end -}}
{{- if $nameCollision -}}
{{- $valid = false -}}{{- $activate = false -}}{{- $desired = dict -}}
{{- range $name, $rule := $owned -}}
{{- $annotations := dict -}}{{- range $key, $value := ($rule.metadata.annotations | default dict) -}}
{{- if hasPrefix "argocd.argoproj.io/" $key -}}{{- $_ := set $annotations $key $value -}}{{- end -}}{{- end -}}
{{- $_ := set $desired $name (dict "apiVersion" $rule.apiVersion "kind" $rule.kind "metadata" (dict "name" $name "annotations" $annotations) "spec" $rule.spec) -}}
{{- end -}}
{{- end -}}
{{- else -}}
{{- /* Preserve owned resources on observation loss; omission would delete them. */ -}}
{{- range $name, $rule := $owned -}}
{{- $annotations := dict -}}
{{- range $key, $value := ($rule.metadata.annotations | default dict) -}}
{{- if hasPrefix "argocd.argoproj.io/" $key -}}{{- $_ := set $annotations $key $value -}}{{- end -}}
{{- end -}}
{{- $ruleSpec := deepCopy $rule.spec -}}
{{- $saved := get $baseline $name | default dict -}}
{{- $repairIdentity := and (eq $handoff "activate") (not (empty $saved))
  (eq (include "nat.identity" (dict "rule" $rule "spec" $spec "name" $name "xr" $xr)) "true")
  (eq $rule.metadata.uid ($saved.uid | default ""))
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $rule) ($saved.externalName | default "")) -}}
{{- if and $repairIdentity (eq ($ruleSpec.deletionPolicy | default "") "Delete")
  (eq (join "," (sortAlpha (uniq ($ruleSpec.managementPolicies | default list)))) "Delete,LateInitialize,Observe,Update") -}}
{{- $_ := set $ruleSpec "deletionPolicy" "Orphan" -}}
{{- $_ := set $ruleSpec "managementPolicies" (list "Observe" "Update" "LateInitialize") -}}
{{- end -}}
{{- $_ := set $desired $name (dict "apiVersion" $rule.apiVersion "kind" $rule.kind "metadata" (dict "name" $name "annotations" $annotations) "spec" $ruleSpec) -}}
{{- end -}}{{- end -}}
{{- $acknowledgementHold := false -}}
{{- range $name, $rule := $desired -}}
{{- if hasKey $owned $name -}}
{{- $acknowledgement := include "owned.acknowledgement" (dict "observed" (get $owned $name) "desired" $rule "identityVerified" (get $identityVerified $name | default false)) | fromJson -}}
{{- $_ := set $desired $name $acknowledgement.resource -}}
{{- if $acknowledgement.hold -}}{{- $acknowledgementHold = true -}}{{- end -}}
{{- end -}}{{- end -}}
{{- if $acknowledgementHold -}}{{- $rulesReady = false -}}{{- $activate = false -}}{{- end -}}
{{- $guardsReady := and $valid (not $policyPending) (not $acknowledgementHold) (gt (len $desired) 0) (eq (len $known) (len $desired)) (or (not $handoff) $adoptionComplete $ownershipReady) -}}
{{- if and (eq $handoff "activate") (not $adoptionComplete) -}}{{- $guardsReady = false -}}{{- end -}}
{{- $observers = append $observers (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation "cluster"))
  "spec" (dict "managementPolicies" (list "Observe") "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "infrastructure.cluster.x-k8s.io/v1beta2" "kind" "AWSCluster"
      "metadata" (dict "name" $spec.awsClusterName "namespace" $spec.awsClusterNamespace))))) -}}
{{- range $observers -}}
{{- if not $guardsReady -}}{{- $_ := set .metadata.annotations $readyAnnotation "False" -}}{{- end -}}
{{ template "emit" . }}
{{- end -}}
{{- range $name, $rule := $desired -}}
{{- $_ := set $rule.metadata.annotations $annotation (printf "rule-%s" $name) -}}
{{- if not $guardsReady -}}{{- $_ := set $rule.metadata.annotations $readyAnnotation "False" -}}{{- end -}}
{{ template "emit" $rule }}
{{- end -}}
{{ template "emit" (dict "apiVersion" $xr.apiVersion "kind" $xr.kind "metadata" (dict "name" $xr.metadata.name)
  "status" (dict "adoptionComplete" $adoptionComplete "sourcesReady" $valid "ownershipReady" $ownershipReady "rulesReady" $rulesReady "handoffActive" $activate "handoff" $baseline)) }}
`.trim();
