/** NAT addresses come from CAPA's reconciled networkStatus, never an AWS CLI
 * lookup or a copied literal. Existing rules are matched by their current CIDR
 * before assigning new addresses, so CAPA list order cannot swap identities. */
export const CLUSTER_NAT_INGRESS_TEMPLATE = String.raw`
{{- define "emit" }}
---
{{ . | toJson }}
{{ end -}}
{{- $spec := .observed.composite.resource.spec -}}
{{- $resources := .observed.resources | default dict -}}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" -}}
{{- $observerReady := false -}}{{- $observerSynced := false -}}
{{- range (dig "resource" "status" "conditions" (list) (get $resources "cluster" | default dict)) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $observerReady = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $observerSynced = true -}}{{- end -}}
{{- end -}}
{{- $cluster := dig "resource" "status" "atProvider" "manifest" (dict) (get $resources "cluster" | default dict) -}}
{{- $ips := dig "status" "networkStatus" "natGatewaysIPs" (list) $cluster -}}
{{- $valid := and $observerReady $observerSynced (eq (dig "apiVersion" "" $cluster) "infrastructure.cluster.x-k8s.io/v1beta2")
  (eq (dig "kind" "" $cluster) "AWSCluster")
  (eq (dig "metadata" "name" "" $cluster) $spec.awsClusterName)
  (eq (dig "metadata" "namespace" "" $cluster) $spec.awsClusterNamespace)
  (eq (dig "spec" "region" "" $cluster) $spec.awsClusterRegion)
  (dig "status" "ready" false $cluster) (kindIs "slice" $ips) -}}
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
{{- end -}}
{{- end -}}
{{- end -}}
{{- $known := dict -}}
{{- $adoptionComplete := dig "status" "adoptionComplete" false .observed.composite.resource -}}
{{- $adoptionValid := true -}}
{{- range $name := ($spec.existingRuleNames | default list) -}}
{{- $rule := dig "resource" "status" "atProvider" "manifest" (dict) (get $resources (printf "existing-%s" $name) | default dict) -}}
{{- $matches := and (eq (dig "apiVersion" "" $rule) "ec2.aws.upbound.io/v1beta1")
  (eq (dig "kind" "" $rule) "SecurityGroupIngressRule") (eq (dig "metadata" "name" "" $rule) $name)
  (eq (dig "spec" "forProvider" "region" "" $rule) $spec.region)
  (eq (dig "spec" "providerConfigRef" "name" "" $rule) $spec.awsProviderConfigName)
  (eq (dig "spec" "forProvider" "securityGroupIdRef" "name" "" $rule) $spec.securityGroupName)
  (eq (dig "spec" "forProvider" "ipProtocol" "" $rule) $spec.ipProtocol)
  (eq (toString (dig "spec" "forProvider" "fromPort" -999 $rule)) (toString $spec.fromPort))
  (eq (toString (dig "spec" "forProvider" "toPort" -999 $rule)) (toString $spec.toPort))
  (regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$" (dig "spec" "forProvider" "cidrIpv4" "" $rule)) -}}
{{- if $matches -}}{{- $_ := set $known $name $rule -}}{{- else -}}{{- $adoptionValid = false -}}{{- end -}}
{{ template "emit" (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation (printf "existing-%s" $name)))
  "spec" (dict "managementPolicies" (list "Observe") "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "SecurityGroupIngressRule" "metadata" (dict "name" $name))))) }}
{{- end -}}
{{- range $key, $value := $resources -}}
{{- if hasPrefix "rule-" $key -}}
{{- $rule := $value.resource -}}
{{- if eq (printf "rule-%s" $rule.metadata.name) $key -}}{{- $_ := set $known $rule.metadata.name $rule -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- $valid = and $valid (or $adoptionComplete $adoptionValid) -}}
{{- $assignments := dict -}}{{- $used := dict -}}
{{- if $valid -}}
{{- /* Keep a current CIDR on its existing MR even if CAPA reorders the IP list. */ -}}
{{- range $name := keys $known | sortAlpha -}}
{{- $ip := dig "spec" "forProvider" "cidrIpv4" "" (get $known $name) | trimSuffix "/32" -}}
{{- if and (hasKey $wanted $ip) (not (hasKey $used $ip)) -}}
{{- $_ := set $assignments $name $ip -}}{{- $_ := set $used $ip true -}}
{{- end -}}
{{- end -}}
{{- range $ip := keys $wanted | sortAlpha -}}
{{- if not (hasKey $used $ip) -}}
{{- $name := "" -}}
{{- range $candidate := ($spec.existingRuleNames | default list) -}}
{{- if and (not $name) (not (hasKey $assignments $candidate)) -}}{{- $name = $candidate -}}{{- end -}}
{{- end -}}
{{- if not $name -}}{{- $name = printf "%s-%s" $spec.name ($ip | sha256sum | trunc 12) -}}{{- end -}}
{{- $_ := set $assignments $name $ip -}}{{- $_ := set $used $ip true -}}
{{- end -}}
{{- end -}}
{{- range $name, $ip := $assignments -}}
{{- $previous := get $known $name | default dict -}}
{{- $for := dig "spec" "forProvider" (dict) $previous | deepCopy -}}
{{- $_ := set $for "region" $spec.region -}}{{- $_ := set $for "securityGroupIdRef" (dict "name" $spec.securityGroupName) -}}
{{- $_ := set $for "ipProtocol" $spec.ipProtocol -}}{{- $_ := set $for "fromPort" $spec.fromPort -}}{{- $_ := set $for "toPort" $spec.toPort -}}
{{- $_ := set $for "cidrIpv4" (printf "%s/32" $ip) -}}
{{- if not $previous -}}{{- $_ := set $for "description" $spec.description -}}{{- $_ := set $for "tags" (dict "Name" $name) -}}{{- end -}}
{{ template "emit" (dict "apiVersion" "ec2.aws.upbound.io/v1beta1" "kind" "SecurityGroupIngressRule"
  "metadata" (dict "name" $name "annotations" (dict $annotation (printf "rule-%s" $name)))
  "spec" (dict "deletionPolicy" "Delete" "managementPolicies" (list "Observe" "Create" "Update" "Delete" "LateInitialize")
    "providerConfigRef" (dict "name" $spec.awsProviderConfigName) "forProvider" $for)) }}
{{- end -}}
{{- $adoptionComplete = true -}}
{{- else -}}
{{- /* Missing observations never cause Crossplane to revoke an existing rule. */ -}}
{{- range $key, $value := $resources -}}
{{- if hasPrefix "rule-" $key -}}
{{- $rule := $value.resource -}}
{{ template "emit" (dict "apiVersion" $rule.apiVersion "kind" $rule.kind
  "metadata" (dict "name" $rule.metadata.name "annotations" (dict $annotation $key)) "spec" $rule.spec) }}
{{- end -}}
{{- end -}}
{{- end -}}
{{ template "emit" (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "annotations" (dict $annotation "cluster" "gotemplating.fn.crossplane.io/ready" (ternary "True" "False" $valid)))
  "spec" (dict "managementPolicies" (list "Observe") "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "infrastructure.cluster.x-k8s.io/v1beta2" "kind" "AWSCluster"
      "metadata" (dict "name" $spec.awsClusterName "namespace" $spec.awsClusterNamespace))))) }}
{{ template "emit" (dict "apiVersion" "nebula.io/v1alpha1" "kind" "XAwsClusterNatIngress"
  "status" (dict "adoptionComplete" $adoptionComplete "sourcesReady" $valid)) }}
`.trim();
