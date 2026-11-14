import { MUTABLE_OWNED_POLICIES, OBSERVE_POLICIES } from "../../../../utils/crossplane-policies";
import { AWS_NLB_PREFIX_LIST_ANNOTATION } from "./constants";
import { NETWORK_OBSERVATION_HELPERS } from "../network-observation";

export const AWS_NLB_ACCESS_TEMPLATE = String.raw`
${NETWORK_OBSERVATION_HELPERS}
{{- define "access.emit" }}
---
{{ . | toJson }}
{{ end -}}
{{- $xr := .observed.composite.resource -}}{{- $spec := $xr.spec -}}
{{- $resources := .observed.resources | default dict -}}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" -}}
{{- $readyAnnotation := "gotemplating.fn.crossplane.io/ready" -}}
{{- $prefixAnnotation := "${AWS_NLB_PREFIX_LIST_ANNOTATION}" -}}
{{- $valid := true -}}{{- $wanted := dict -}}{{- $observers := list -}}
{{- range $index, $source := $spec.sources -}}
{{- if hasKey $source "cidr" -}}
{{- if eq (include "network.cidr4" $source.cidr) "true" -}}{{- $_ := set $wanted $source.cidr true -}}{{- else -}}{{- $valid = false -}}{{- end -}}
{{- else -}}
{{- $key := printf "source-%d" $index -}}
{{- $observer := dig "resource" (dict) (get $resources $key | default dict) -}}
{{- $observed := dig "status" "atProvider" "manifest" (dict) $observer -}}
{{- $sourceReady := eq (include "network.ready" $observer) "true" -}}
{{- $kind := "EIP" -}}{{- $version := "ec2.aws.upbound.io/v1beta1" -}}{{- $ref := $source.eip | default dict -}}
{{- if hasKey $source "awsCluster" -}}
{{- $kind = "AWSCluster" -}}{{- $version = "infrastructure.cluster.x-k8s.io/v1beta2" -}}{{- $ref = $source.awsCluster -}}
{{- $sourceReady = and $sourceReady (eq (dig "metadata" "namespace" "" $observed) $ref.namespace)
  (eq (dig "spec" "region" "" $observed) $ref.region) (dig "status" "ready" false $observed) -}}
{{- if hasKey ($observed.status | default dict) "observedGeneration" -}}
{{- $sourceReady = and $sourceReady (eq (toString $observed.status.observedGeneration) (toString (dig "metadata" "generation" 0 $observed))) -}}
{{- end -}}
{{- if $ref.vpcCidr -}}
{{- $cidr := dig "spec" "network" "vpc" "cidrBlock" "" $observed -}}
{{- if eq (include "network.cidr4" $cidr) "true" -}}{{- $_ := set $wanted $cidr true -}}{{- else -}}{{- $sourceReady = false -}}{{- end -}}
{{- end -}}
{{- if $ref.natGateways -}}
{{- $ips := dig "status" "networkStatus" "natGatewaysIPs" (list) $observed -}}
{{- if not (kindIs "slice" $ips) -}}{{- $sourceReady = false -}}
{{- else -}}
{{- if or (lt (len $ips) 1) (gt (len $ips) 32) -}}{{- $sourceReady = false -}}{{- end -}}
{{- range $ip := $ips -}}
{{- if eq (include "network.ipv4" $ip) "true" -}}{{- $_ := set $wanted (printf "%s/32" $ip) true -}}{{- else -}}{{- $sourceReady = false -}}{{- end -}}
{{- end -}}{{- end -}}
{{- end -}}
{{- else -}}
{{- $sourceReady = and $sourceReady (eq (include "network.ready" $observed) "true")
  (eq (dig "spec" "forProvider" "region" "" $observed) $ref.region)
  (eq (dig "spec" "providerConfigRef" "name" "" $observed) $spec.awsProviderConfigName) -}}
{{- $ip := dig "status" "atProvider" "publicIp" "" $observed -}}
{{- if eq (include "network.ipv4" $ip) "true" -}}{{- $_ := set $wanted (printf "%s/32" $ip) true -}}{{- else -}}{{- $sourceReady = false -}}{{- end -}}
{{- end -}}
{{- $sourceReady = and $sourceReady (eq (dig "apiVersion" "" $observed) $version) (eq (dig "kind" "" $observed) $kind)
  (eq (dig "metadata" "name" "" $observed) $ref.name) (not (dig "metadata" "deletionTimestamp" "" $observed)) -}}
{{- if not $sourceReady -}}{{- $valid = false -}}{{- end -}}
{{- $metadata := dict "name" $ref.name -}}{{- if eq $kind "AWSCluster" -}}{{- $_ := set $metadata "namespace" $ref.namespace -}}{{- end -}}
{{- $observers = append $observers (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation $key))
  "spec" (dict "managementPolicies" (list ${OBSERVE_POLICIES.map(policy => JSON.stringify(policy)).join(" ")}) "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" $version "kind" $kind "metadata" $metadata)))) -}}
{{- end -}}{{- end -}}
{{- $cidrs := keys $wanted | sortAlpha -}}
{{- $valid = and $valid (ge (len $cidrs) 1) (le (len $cidrs) (int $spec.maxEntries)) -}}
{{- $currentPrefix := dig "resource" (dict) (get $resources "prefix-list" | default dict) -}}
{{- $prefix := dict -}}
{{- if $valid -}}
{{- $entries := list -}}{{- range $cidr := $cidrs -}}{{- $entries = append $entries (dict "cidr" $cidr) -}}{{- end -}}
{{- $prefix = dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "ManagedPrefixList"
  "metadata" (dict "name" $spec.name "annotations" (dict $annotation "prefix-list"))
  "spec" (dict "managementPolicies" (list ${MUTABLE_OWNED_POLICIES.map(policy => JSON.stringify(policy)).join(" ")}) "deletionPolicy" "Delete"
    "providerConfigRef" (dict "name" $spec.awsProviderConfigName)
    "forProvider" (dict "region" $spec.region "name" $spec.name "addressFamily" "IPv4" "maxEntries" $spec.maxEntries "entry" $entries)) -}}
{{- else if $currentPrefix.spec -}}
{{- $prefix = dict "apiVersion" $currentPrefix.apiVersion "kind" $currentPrefix.kind
  "metadata" (dict "name" $currentPrefix.metadata.name "annotations" (dict $annotation "prefix-list" $readyAnnotation "False"))
  "spec" (deepCopy $currentPrefix.spec) -}}
{{- end -}}
{{- if $prefix -}}{{ template "access.emit" $prefix }}{{- end -}}
{{- $at := dig "status" "atProvider" (dict) $currentPrefix -}}
{{- $prefixId := get $at "id" | default "" -}}
{{- $actualCidrs := list -}}{{- range (get $at "entry" | default list) -}}{{- $actualCidrs = append $actualCidrs .cidr -}}{{- end -}}
{{- $prefixReady := and $valid (eq (include "network.ready" $currentPrefix) "true")
  (regexMatch "^pl-[0-9a-f]+$" $prefixId)
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $currentPrefix) $prefixId)
  (eq (dig "metadata" "name" "" $currentPrefix) $spec.name)
  (eq (dig "spec" "providerConfigRef" "name" "" $currentPrefix) $spec.awsProviderConfigName)
  (eq (get $at "region" | default "") $spec.region) (eq (get $at "addressFamily" | default "") "IPv4")
  (eq (toJson (sortAlpha (uniq $actualCidrs))) (toJson $cidrs))
  (eq (toString (get $at "maxEntries")) (toString $spec.maxEntries)) -}}
{{- $bindingsReady := true -}}
{{- range $index, $service := $spec.services -}}
{{- $key := printf "service-%d" $index -}}
{{- $current := dig "resource" (dict) (get $resources $key | default dict) -}}
{{- $live := dig "status" "atProvider" "manifest" (dict) $current -}}
{{- $targetKnown := and (eq (dig "apiVersion" "" $live) "v1") (eq (dig "kind" "" $live) "Service")
  (eq (dig "metadata" "name" "" $live) $service.name) (eq (dig "metadata" "namespace" "" $live) $service.namespace)
  (not (dig "metadata" "deletionTimestamp" "" $live)) -}}
{{- $targetAnnotations := dig "metadata" "annotations" (dict) $live -}}
{{- $compatible := and $targetKnown (eq (dig "spec" "type" "" $live) "LoadBalancer")
  (or (eq (dig "spec" "loadBalancerClass" "" $live) "service.k8s.aws/nlb") (and (eq (dig "spec" "loadBalancerClass" "" $live) "") (has (get $targetAnnotations "service.beta.kubernetes.io/aws-load-balancer-type" | default "") (list "external" "nlb-ip"))))
  (eq (get $targetAnnotations "service.beta.kubernetes.io/aws-load-balancer-security-groups" | default "") "")
  (ne (get $targetAnnotations "service.beta.kubernetes.io/aws-load-balancer-disable-nlb-sg" | default "false") "true")
  (eq (get $targetAnnotations "service.beta.kubernetes.io/aws-load-balancer-ip-address-type" | default "ipv4") "ipv4") -}}
{{- $manifest := dict "apiVersion" "v1" "kind" "Service" "metadata" (dict "name" $service.name "namespace" $service.namespace) -}}
{{- $desired := dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation $key $readyAnnotation "False"))
  "spec" (dict "managementPolicies" (fromJson ${JSON.stringify(JSON.stringify(OBSERVE_POLICIES))}) "deletionPolicy" "Orphan"
    "providerConfigRef" (dict "name" $spec.kubeProviderConfigName) "forProvider" (dict "manifest" $manifest)) -}}
{{- $value := "" -}}
{{- if and $targetKnown (or (and $prefixReady $compatible) (not $spec.enabled)) -}}
{{- if $spec.enabled -}}{{- $value = $prefixId -}}{{- end -}}
{{- $_ := set $manifest.metadata "annotations" (dict $prefixAnnotation $value) -}}
{{- $_ := set $desired.spec "managementPolicies" (list "Observe" "Update") -}}
{{- if and (eq (include "network.ready" $current) "true") (eq (get $targetAnnotations $prefixAnnotation | default "") $value)
  (or (not $spec.enabled) (hasKey $targetAnnotations $prefixAnnotation)) -}}
{{- $_ := unset $desired.metadata.annotations $readyAnnotation -}}
{{- else -}}{{- $bindingsReady = false -}}{{- end -}}
{{- else if and $compatible $current.spec -}}
{{- $_ := set $desired "spec" (deepCopy $current.spec) -}}{{- $bindingsReady = false -}}
{{- else -}}{{- $bindingsReady = false -}}{{- end -}}
{{- if $desired -}}{{ template "access.emit" $desired }}{{- end -}}
{{- end -}}
{{- range $observer := $observers -}}
{{- if not (and $valid $prefixReady $bindingsReady) -}}{{- $_ := set $observer.metadata.annotations $readyAnnotation "False" -}}{{- end -}}
{{ template "access.emit" $observer }}
{{- end -}}
{{ template "access.emit" (dict "apiVersion" $xr.apiVersion "kind" $xr.kind "metadata" (dict "name" $xr.metadata.name)
  "status" (dict "sourcesReady" $valid "prefixListReady" $prefixReady "bindingsReady" $bindingsReady
    "prefixListId" (ternary $prefixId "" $prefixReady) "cidrs" (ternary $cidrs (dig "status" "cidrs" (list) $xr) $valid))) }}
`.trim();
