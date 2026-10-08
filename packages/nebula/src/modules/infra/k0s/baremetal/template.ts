/** Crossplane owns the resource graph. The Job only installs and verifies an OS.
 * Keep the template executable in function-go-templating and in the Go test harness. */
export function baremetalWorkerTemplate(profile: Record<string, unknown>): string {
  return `{{- $profile := ${JSON.stringify(JSON.stringify(profile))} | fromJson -}}\n` + TEMPLATE;
}

const TEMPLATE = String.raw`
{{- define "emit" -}}
---
{{ . | toJson }}
{{ end -}}
{{- define "ready" -}}
{{- $ready := false -}}{{- $synced := false -}}
{{- range (dig "status" "conditions" (list) .) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $ready = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $synced = true -}}{{- end -}}
{{- end -}}
{{- and $ready $synced -}}
{{- end -}}
{{- define "subset" -}}
{{- $ok := true -}}
{{- if kindIs "map" .expected -}}
{{- if not (kindIs "map" .actual) -}}{{- $ok = false -}}{{- else -}}
{{- range $key, $value := .expected -}}
{{- if not (hasKey $.actual $key) -}}{{- $ok = false -}}{{- else -}}
{{- $ok = and $ok (eq (include "subset" (dict "expected" $value "actual" (get $.actual $key))) "true") -}}
{{- end -}}{{- end -}}{{- end -}}
{{- else if kindIs "slice" .expected -}}
{{- if not (kindIs "slice" .actual) -}}{{- $ok = false -}}{{- else if ne (len .expected) (len .actual) -}}{{- $ok = false -}}{{- else -}}
{{- range $index, $value := .expected -}}
{{- $ok = and $ok (eq (include "subset" (dict "expected" $value "actual" (index $.actual $index))) "true") -}}
{{- end -}}{{- end -}}
{{- else -}}{{- $ok = eq (.expected | toJson) (.actual | toJson) -}}{{- end -}}
{{- $ok -}}
{{- end -}}
{{- define "object" -}}
{{- $old := dig "resource" (dict) (get .resources .key | default dict) -}}
{{- $actual := dig "status" "atProvider" "manifest" (dict) $old -}}
{{- $gate := true -}}{{- if hasKey . "gate" -}}{{- $gate = .gate -}}{{- end -}}
{{- $ready := and $gate (eq (include "ready" $old) "true")
  (eq (dig "spec" "providerConfigRef" "name" "" $old) .provider)
  (eq (dig "metadata" "name" "" $actual) .manifest.metadata.name)
  (eq (dig "metadata" "namespace" "" $actual) (.manifest.metadata.namespace | default ""))
  (eq (dig "metadata" "annotations" "baremetal.nebula.io/request-uid" "" $actual) .uid) -}}
{{- $_ := set .manifest.metadata "annotations" (merge (.manifest.metadata.annotations | default dict) (dict "baremetal.nebula.io/request-uid" .uid)) -}}
{{- $spec := dict "deletionPolicy" "Orphan" "managementPolicies" .policies
  "providerConfigRef" (dict "name" .provider) "forProvider" (dict "manifest" .manifest) -}}
{{- if .readiness -}}{{- $_ := set $spec "readiness" .readiness -}}{{- end -}}
{{ template "emit" (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "name" (printf "%s-%s" .prefix .key) "annotations"
    (dict "gotemplating.fn.crossplane.io/composition-resource-name" .key "gotemplating.fn.crossplane.io/ready" (ternary "True" "False" $ready)))
  "spec" $spec) }}
{{- end -}}
{{- $xr := .observed.composite.resource -}}
{{- $resources := .observed.resources | default dict -}}
{{- $uid := $xr.metadata.uid -}}
{{- $hostname := $xr.spec.hostname | default (printf "bm-%s" (replace "." "-" $xr.spec.address)) -}}
{{- $prefix := printf "%s-%s" ($hostname | trunc 50 | trimSuffix "-") ($uid | sha256sum | trunc 12) -}}
{{- $namespace := $profile.namespace -}}
{{- $meta := dict "name" $prefix "namespace" $namespace -}}
{{- $ssh := deepCopy $profile.ssh -}}
{{- if hasKey $xr.spec "sshUser" -}}{{- $_ := set $ssh "user" $xr.spec.sshUser -}}{{- end -}}
{{- if hasKey $xr.spec "sshPort" -}}{{- $_ := set $ssh "port" $xr.spec.sshPort -}}{{- end -}}
{{- $labels := mergeOverwrite (deepCopy ($profile.defaults.nodeLabels | default dict)) ($xr.spec.nodeLabels | default dict) -}}
{{- $_ := set $labels (printf "%s/geo" $profile.tagDomain) ($xr.spec.geo | default $profile.defaults.geo) -}}
{{- $_ := set $labels "topology.kubernetes.io/region" ($xr.spec.region | default $profile.defaults.region) -}}
{{- $_ := set $labels "topology.kubernetes.io/zone" ($xr.spec.zone | default $profile.defaults.zone) -}}
{{- $labelEntries := list -}}
{{- range ($labels | keys | sortAlpha) -}}{{- $labelEntries = append $labelEntries (printf "%s=%s" . (get $labels .)) -}}{{- end -}}
{{- $labelArg := join "," $labelEntries -}}
{{- $taints := $profile.defaults.taints | default list -}}
{{- if hasKey $xr.spec "taints" -}}{{- $taints = $xr.spec.taints -}}{{- end -}}
{{- $taintArg := "" -}}{{- if $taints -}}{{- $taintArg = printf "--register-with-taints=%s" (join "," $taints) -}}{{- end -}}
{{- $request := dict "uid" $uid "spec" (dict "address" $xr.spec.address "hostname" $hostname "ssh" $ssh "installation" $profile.installation)
  "context" (dict "namespace" $namespace "cluster" $profile.clusterName "provider" $profile.kubeProviderConfigName
    "workloadProvider" ($profile.workloadKubeProviderConfigName | default "") "podPrefix" ($profile.ipv6PodCidrPrefix | default "")) -}}
{{- $requestJSON := $request | toJson -}}
{{- $hash := $requestJSON | sha256sum -}}
{{- $previousHash := dig "status" "requestHash" "" $xr -}}
{{- if and $previousHash (ne $previousHash $hash) -}}
{{- fail "installation profile changed for a bound host; restore its CompositionRevision (never automatically reimage)" -}}
{{- end -}}
{{- $snapshot := list "Observe" "Create" -}}
{{- $retained := list "Observe" "Create" "Update" -}}
{{- $context := dict "resources" $resources "uid" $uid "prefix" $prefix "provider" $profile.kubeProviderConfigName -}}
{{- $stateName := printf "%s-state" $prefix -}}
{{- $state := dig "resource" (dict) (get $resources "state" | default dict) -}}
{{- $data := dig "status" "atProvider" "manifest" "data" (dict) $state -}}
{{- $progress := get $data "progress" | default "{}" | fromJson | default dict -}}
{{- $job := dig "resource" (dict) (get $resources "install" | default dict) -}}
{{- $jobManifest := dig "status" "atProvider" "manifest" (dict) $job -}}
{{- $complete := false -}}
{{- $jobFailed := false -}}
{{- range (dig "status" "conditions" (list) $jobManifest) -}}
{{- if and (eq .type "Complete") (eq .status "True") -}}{{- $complete = true -}}{{- end -}}
{{- if and (eq .type "Failed") (eq .status "True") -}}{{- $jobFailed = true -}}{{- end -}}
{{- end -}}
{{- $bound := and (eq ($data.uid | default "") $uid) (eq ($data.requestHash | default "") $hash) -}}
{{- $osReady := and $bound $complete (not $jobFailed) (eq ($data.verifiedRequestHash | default "") $hash)
  (eq ($data.phase | default "") "OSReady") (eq (include "ready" $state) "true") (eq (include "ready" $job) "true")
  (eq (dig "spec" "providerConfigRef" "name" "" $state) $profile.kubeProviderConfigName)
  (eq (dig "spec" "providerConfigRef" "name" "" $job) $profile.kubeProviderConfigName)
  (eq (dig "status" "atProvider" "manifest" "metadata" "name" "" $state) $stateName)
  (eq (dig "status" "atProvider" "manifest" "metadata" "namespace" "" $state) $namespace)
  (eq (dig "metadata" "name" "" $jobManifest) $prefix) (eq (dig "metadata" "namespace" "" $jobManifest) $namespace)
  (eq (dig "metadata" "annotations" "baremetal.nebula.io/request-uid" "" $jobManifest) $uid)
  (eq (dig "metadata" "annotations" "baremetal.nebula.io/request-hash" "" $jobManifest) $hash) -}}

{{ template "object" (merge (dict "key" "request" "policies" $snapshot "manifest"
  (dict "apiVersion" "v1" "kind" "ConfigMap" "metadata" (dict "name" (printf "%s-request" $prefix) "namespace" $namespace)
    "immutable" true "data" (dict "request.json" $requestJSON))) $context) }}
{{ template "object" (merge (dict "key" "state" "policies" $snapshot "manifest"
  (dict "apiVersion" "v1" "kind" "ConfigMap" "metadata" (dict "name" $stateName "namespace" $namespace)
    "data" (dict "uid" $uid "requestHash" $hash))) $context) }}
{{ template "object" (merge (dict "key" "account" "policies" $snapshot "manifest"
  (dict "apiVersion" "v1" "kind" "ServiceAccount" "metadata" (deepCopy $meta))) $context) }}
{{ template "object" (merge (dict "key" "role" "policies" $snapshot "manifest"
  (dict "apiVersion" "rbac.authorization.k8s.io/v1" "kind" "Role" "metadata" (deepCopy $meta)
    "rules" (list (dict "apiGroups" (list "") "resources" (list "configmaps") "resourceNames" (list $stateName) "verbs" (list "get" "patch"))))) $context) }}
{{ template "object" (merge (dict "key" "binding" "policies" $snapshot "manifest"
  (dict "apiVersion" "rbac.authorization.k8s.io/v1" "kind" "RoleBinding" "metadata" (deepCopy $meta)
    "roleRef" (dict "apiGroup" "rbac.authorization.k8s.io" "kind" "Role" "name" $prefix)
    "subjects" (list (dict "kind" "ServiceAccount" "name" $prefix "namespace" $namespace)))) $context) }}
{{- $mounts := list (dict "name" "scripts" "mountPath" "/opt/provisioner" "readOnly" true)
  (dict "name" "request" "mountPath" "/etc/provisioner" "readOnly" true) (dict "name" "scratch" "mountPath" "/tmp") -}}
{{- $volumes := list (dict "name" "scripts" "configMap" (dict "name" $profile.scriptsName))
  (dict "name" "request" "configMap" (dict "name" (printf "%s-request" $prefix)))
  (dict "name" "scratch" "emptyDir" (dict "medium" "Memory" "sizeLimit" "512Mi")) -}}
{{- $secrets := dict "initial" (dict "name" $profile.ssh.secretName "key" "value") "worker" (dict "name" $profile.ssh.workerSecretName "key" "value") -}}
{{- if $profile.ssh.knownHostsSecretName -}}{{- $_ := set $secrets "known-hosts" (dict "name" $profile.ssh.knownHostsSecretName "key" "known_hosts") -}}{{- end -}}
{{- range $key, $secret := $secrets -}}
{{- $mounts = append $mounts (dict "name" $key "mountPath" (printf "/etc/credentials/%s" $key) "readOnly" true) -}}
{{- $volumes = append $volumes (dict "name" $key "secret" (dict "secretName" $secret.name "defaultMode" 288 "items" (list (dict "key" $secret.key "path" "value")))) -}}
{{- end -}}
{{- $jobDesired := dict "apiVersion" "batch/v1" "kind" "Job"
  "metadata" (dict "name" $prefix "namespace" $namespace "annotations" (dict "baremetal.nebula.io/request-hash" $hash))
  "spec" (dict "parallelism" 1 "completions" 1 "backoffLimit" 5 "activeDeadlineSeconds" (add $profile.installation.timeoutSeconds 2400)
    "template" (dict "spec" (dict "restartPolicy" "OnFailure" "serviceAccountName" $prefix
      "securityContext" (dict "runAsNonRoot" true "runAsUser" 65532 "runAsGroup" 65532 "fsGroup" 65532 "seccompProfile" (dict "type" "RuntimeDefault"))
      "containers" (list (dict "name" "install" "image" $profile.image "command" (list "python3" "-B" "/opt/provisioner/runner.py")
        "env" (list (dict "name" "NAMESPACE" "value" $namespace) (dict "name" "STATE_CONFIG_MAP" "value" $stateName))
        "securityContext" (dict "allowPrivilegeEscalation" false "readOnlyRootFilesystem" true "capabilities" (dict "drop" (list "ALL")))
        "resources" (dict "requests" (dict "cpu" "50m" "memory" "128Mi")) "volumeMounts" $mounts)) "volumes" $volumes))) -}}
{{- /* The Job is immutable after creation, including image/scripts across a revision change. */ -}}
{{- $existingJob := dig "spec" "forProvider" "manifest" (dict) $job -}}
{{- if $existingJob -}}{{- $jobDesired = deepCopy $existingJob -}}{{- end -}}
{{ template "object" (merge (dict "key" "install" "policies" $snapshot "gate" $osReady "manifest" $jobDesired
  "readiness" (dict "policy" "DeriveFromCelQuery" "celQuery" "has(object.status) && has(object.status.conditions) && object.status.conditions.exists(c, c.type == 'Complete' && c.status == 'True')")) $context) }}

{{- $cidr := "" -}}
{{- $admissionPublished := dig "status" "admissionPublished" false $xr -}}
{{- $admissionReady := true -}}
{{- if $profile.ipv6PodCidrPrefix -}}
{{- $octets := splitList "." $xr.spec.address -}}
{{- $cidr = printf "%s%x:%x::/64" (trimSuffix ":" $profile.ipv6PodCidrPrefix)
  (add (mul (index $octets 0 | atoi) 256) (index $octets 1 | atoi)) (add (mul (index $octets 2 | atoi) 256) (index $octets 3 | atoi)) -}}
{{- $admissionPublished = or $admissionPublished $osReady -}}
{{- $admissionReady = false -}}
{{- if $admissionPublished -}}
{{- $admissionReady = true -}}
{{- range $key, $kind := dict "cidr" "MutatingAdmissionPolicy" "identity" "ValidatingAdmissionPolicy" -}}
{{- $policyName := printf "nebula-%s-%s" $hostname $key -}}
{{- $policySpec := dict "failurePolicy" "Fail"
  "matchConstraints" (dict "matchPolicy" "Equivalent" "resourceRules" (list (dict "apiGroups" (list "") "apiVersions" (list "v1") "operations" (list "CREATE") "resources" (list "nodes") "scope" "Cluster")))
  "matchConditions" (list (dict "name" "exact-host" "expression" (printf "object.metadata.name == %s" ($hostname | toJson)))) -}}
{{- $bindingSpec := dict "policyName" $policyName -}}
{{- if eq $key "cidr" -}}
{{- $_ := set $policySpec "reinvocationPolicy" "Never" -}}
{{- $_ := set $policySpec "mutations" (list (dict "patchType" "ApplyConfiguration" "applyConfiguration"
  (dict "expression" (printf "Object{metadata: Object.metadata{annotations: {\"network.cilium.io/ipv6-pod-cidr\": %s}}}" ($cidr | toJson))))) -}}
{{- else -}}
{{- $_ := set $policySpec "validations" (list (dict "expression" "request.userInfo.username == \"system:node:\" + object.metadata.name" "message" "This Node must register through its kubelet")) -}}
{{- $_ := set $bindingSpec "validationActions" (list "Deny") -}}
{{- end -}}
{{- range $suffix, $spec := dict "policy" $policySpec "binding" $bindingSpec -}}
{{- $resourceKey := printf "%s-%s" $key $suffix -}}
{{- $actualKind := $kind -}}{{- if eq $suffix "binding" -}}{{- $actualKind = printf "%sBinding" $kind -}}{{- end -}}
{{- $observed := dig "resource" (dict) (get $resources $resourceKey | default dict) -}}
{{- $admissionReady = and $admissionReady (eq (include "ready" $observed) "true")
  (eq (dig "status" "atProvider" "manifest" "metadata" "annotations" "baremetal.nebula.io/request-uid" "" $observed) $uid)
  (eq (dig "status" "atProvider" "manifest" "metadata" "name" "" $observed) $policyName)
  (eq (include "subset" (dict "expected" $spec "actual" (dig "status" "atProvider" "manifest" "spec" (dict) $observed))) "true")
  (eq (dig "spec" "providerConfigRef" "name" "" $observed) $profile.workloadKubeProviderConfigName) -}}
{{ template "object" (merge (dict "key" $resourceKey "policies" $retained "provider" $profile.workloadKubeProviderConfigName "manifest"
  (dict "apiVersion" "admissionregistration.k8s.io/v1" "kind" $actualKind "metadata" (dict "name" $policyName) "spec" $spec)) $context) }}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Latch publication, not readiness: a temporarily absent observation must
       not withdraw an existing pool or MachineDeployment from desired state. */ -}}
{{- $enrollmentPublished := or (dig "status" "enrollmentPublished" false $xr) (and $osReady $admissionReady) -}}
{{- $workerReady := false -}}
{{- if $enrollmentPublished -}}
{{- range $index, $resource := $profile.enrollment -}}
{{- $manifest := $resource | toJson | replace "\"NEBULA_HOSTNAME\"" ($hostname | toJson) | replace "\"NEBULA_ADDRESS\"" ($xr.spec.address | toJson) | fromJson -}}
{{- $key := index (list "pool" "remote-template" "bootstrap-template" "worker") $index -}}
{{- if eq $key "pool" -}}{{- $_ := set $manifest.spec.machine "port" $ssh.port -}}{{- end -}}
{{- if eq $key "bootstrap-template" -}}
{{- $args := $manifest.spec.template.spec.args -}}
{{- $_ := set $manifest.spec.template.spec "args" (list (index $args 0 | replace "NEBULA_LABELS" $labelArg) (index $args 1 | replace "NEBULA_TAINT_ARGS" $taintArg)) -}}
{{- end -}}
{{- $readiness := dict -}}
{{- $gate := and $osReady $admissionReady -}}
{{- if eq $key "worker" -}}
{{- $readiness = dict "policy" "DeriveFromCelQuery" "celQuery" "has(object.status) && has(object.status.observedGeneration) && object.status.observedGeneration == object.metadata.generation && has(object.status.readyReplicas) && object.status.readyReplicas == object.spec.replicas && has(object.status.conditions) && object.status.conditions.exists(c, c.type == 'MachinesReady' && c.status == 'True' && has(c.observedGeneration) && c.observedGeneration == object.metadata.generation)" -}}
{{- $observed := dig "resource" (dict) (get $resources $key | default dict) -}}
{{- $actual := dig "status" "atProvider" "manifest" (dict) $observed -}}
{{- $generation := dig "metadata" "generation" 0 $actual | int64 -}}
{{- $machinesReady := false -}}
{{- range (dig "status" "conditions" (list) $actual) -}}
{{- if and (eq .type "MachinesReady") (eq .status "True") (eq (.observedGeneration | default 0 | int64) $generation) -}}{{- $machinesReady = true -}}{{- end -}}
{{- end -}}
{{- $workerReady = and $osReady $admissionReady (eq (include "ready" $observed) "true")
  $machinesReady (eq (dig "spec" "providerConfigRef" "name" "" $observed) $profile.kubeProviderConfigName)
  (eq (dig "metadata" "name" "" $actual) $hostname) (eq (dig "metadata" "namespace" "" $actual) $namespace)
  (eq (dig "metadata" "annotations" "baremetal.nebula.io/request-uid" "" $actual) $uid)
  (gt $generation 0) (eq (dig "status" "observedGeneration" 0 $actual | int64) $generation)
  (eq (dig "status" "readyReplicas" 0 $actual | int64) 1) -}}
{{- $gate = $workerReady -}}
{{- end -}}
{{ template "object" (merge (dict "key" $key "policies" $retained "manifest" $manifest "readiness" $readiness "gate" $gate) $context) }}
{{- end -}}
{{- end -}}
{{- $phase := "Pending" -}}
{{- if $bound -}}{{- $phase = $data.phase | default "Pending" -}}{{- end -}}
{{- if $osReady -}}{{- $phase = "OSReady" -}}{{- end -}}
{{- if and $osReady $enrollmentPublished -}}{{- $phase = "Enrolling" -}}{{- end -}}
{{- if $workerReady -}}{{- $phase = "Ready" -}}{{- end -}}
{{- if $jobFailed -}}{{- $phase = "Failed" -}}{{- end -}}
{{ template "emit" (dict "apiVersion" $xr.apiVersion "kind" $xr.kind "status"
  (dict "phase" $phase "osReady" $osReady "workerReady" $workerReady "address" $xr.spec.address "hostname" $hostname "ipv6PodCidr" $cidr
    "lastError" ($progress.lastError | default "") "requestHash" $hash "admissionPublished" $admissionPublished "enrollmentPublished" $enrollmentPublished)) }}
`;
