/**
 * Recover a missing Upjet Synced generation through a provider-acknowledged
 * pause, read-only description diff, and exact restoration. The caller must
 * independently verify controller ownership, saved UID/cloud binding, provider,
 * region, resource name and observed cloud identity.
 *
 * include "owned.acknowledgement" with { observed, desired, identityVerified }
 * returns JSON { resource, hold, retiring }. Apply after resource selection and
 * combine hold with every readiness guard. Preflight before retirement planning.
 * In-flight repair freezes the observed spec except recorded description and
 * lifecycle fields. Provider-owned binding/create annotations are never emitted.
 * Completed records remain SSA-owned and allow subsequent desired changes; a
 * later missing generation can start another independently acknowledged repair.
 */
export const OWNED_RESOURCE_ACKNOWLEDGEMENT = String.raw`
{{- define "owned.acknowledgement-lifecycle" -}}
{{- $policies := .managementPolicies | default list -}}
{{- $valid := and (kindIs "slice" $policies) (kindIs "string" .deletionPolicy) -}}
{{- if $valid -}}
{{- range $policies -}}{{- if not (kindIs "string" .) -}}{{- $valid = false -}}{{- end -}}{{- end -}}
{{- end -}}
{{- if $valid -}}
{{- $sorted := join "," (sortAlpha $policies) -}}
{{- $valid = or (and (eq .deletionPolicy "Orphan") (eq $sorted "LateInitialize,Observe,Update") (eq (len $policies) 3))
  (and (eq .deletionPolicy "Delete") (eq $sorted "Delete,Observe") (eq (len $policies) 2))
  (and (eq .deletionPolicy "Delete") (eq $sorted "Create,Delete,LateInitialize,Observe,Update") (eq (len $policies) 5)) -}}
{{- end -}}{{- $valid -}}
{{- end -}}
{{- define "owned.acknowledgement-probe-description" -}}
{{- $baseline := pick . "uid" "externalName" "startedGeneration" "restoreDescriptionPresent" "restoreDescription" "restorePausedPresent" "restorePausedValue" "restorePolicies" "restoreDeletionPolicy" "cloudSpecHash" -}}
{{- $probe := printf "nebula-generation-ack-%s" ($baseline | toJson | sha256sum | trunc 32) -}}
{{- if eq $probe .restoreDescription -}}{{- $probe = printf "%s-alternate" $probe -}}{{- end -}}
{{- $probe -}}
{{- end -}}
{{- define "owned.acknowledgement-preserve" -}}
{{- $observed := .observed -}}{{- $annotations := deepCopy (dig "metadata" "annotations" (dict) (.desired | default dict)) -}}
{{- range $key, $value := $annotations -}}
{{- if or (eq $key "crossplane.io/external-name") (hasPrefix "crossplane.io/external-create-" $key) -}}{{- $_ := unset $annotations $key -}}{{- end -}}
{{- end -}}
{{- range $key, $value := (dig "metadata" "annotations" (dict) $observed) -}}
{{- if or (hasPrefix "argocd.argoproj.io/" $key) (eq $key "nebula.io/observed-generation-repair") (eq $key "crossplane.io/paused") -}}
{{- $_ := set $annotations $key $value -}}
{{- end -}}{{- end -}}
{{- $metadata := dict "name" $observed.metadata.name "annotations" $annotations -}}
{{- if $observed.metadata.namespace -}}{{- $_ := set $metadata "namespace" $observed.metadata.namespace -}}{{- end -}}
{{- dict "apiVersion" $observed.apiVersion "kind" $observed.kind "metadata" $metadata "spec" (deepCopy $observed.spec) | toJson -}}
{{- end -}}
{{- define "owned.acknowledgement" -}}
{{- $observed := .observed -}}{{- $preserved := include "owned.acknowledgement-preserve" . | fromJson -}}
{{- $selected := deepCopy (.desired | default $preserved) -}}{{- $desired := deepCopy $selected -}}
{{- $identity := .identityVerified | default false -}}
{{- $key := "nebula.io/observed-generation-repair" -}}{{- $pauseKey := "crossplane.io/paused" -}}
{{- $annotations := dig "metadata" "annotations" (dict) $observed -}}
{{- $uid := dig "metadata" "uid" "" $observed -}}{{- $externalName := get $annotations "crossplane.io/external-name" | default "" -}}
{{- $generation := dig "metadata" "generation" 0 $observed -}}
{{- $identity = and $identity (ne $uid "") (ne $externalName "")
  (regexMatch "^[1-9][0-9]*$" (toString $generation)) (not (dig "metadata" "deletionTimestamp" "" $observed)) -}}
{{- $pausePresent := hasKey $annotations $pauseKey -}}{{- $pause := get $annotations $pauseKey | default "" -}}
{{- $paused := eq $pause "true" -}}
{{- $for := $observed.spec.forProvider -}}{{- $descriptionPresent := hasKey $for "description" -}}{{- $description := get $for "description" -}}
{{- if not $descriptionPresent -}}{{- $description = "" -}}{{- end -}}
{{- $cloudSpec := deepCopy $observed.spec -}}
{{- $_ := unset $cloudSpec "managementPolicies" -}}{{- $_ := unset $cloudSpec "deletionPolicy" -}}{{- $_ := unset $cloudSpec.forProvider "description" -}}
{{- $hash := $cloudSpec | toJson | sha256sum -}}
{{- $ready := false -}}{{- $synced := false -}}{{- $missing := false -}}{{- $current := false -}}{{- $pausedAck := false -}}{{- $syncedCount := 0 -}}
{{- range (dig "status" "conditions" (list) $observed) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $ready = true -}}{{- end -}}
{{- if eq .type "Synced" -}}
{{- $syncedCount = add1 $syncedCount -}}{{- $synced = eq .status "True" -}}
{{- $missing = or (not (hasKey . "observedGeneration")) (eq (toString (get . "observedGeneration")) "0") -}}
{{- $current = and (hasKey . "observedGeneration") (eq (toString .observedGeneration) (toString $generation)) -}}
{{- $pausedAck = and $current (eq .status "False") (eq (.reason | default "") "ReconcilePaused") -}}
{{- end -}}{{- end -}}
{{- $healthy := and $ready $synced (eq (int $syncedCount) 1) -}}
{{- $current = and $healthy $current -}}{{- $pausedAck = and $pausedAck (eq (int $syncedCount) 1) -}}
{{- $hold := false -}}{{- $start := false -}}
{{- $retiring := and $identity (eq ($observed.spec.deletionPolicy | default "") "Delete") (eq (join "," (sortAlpha ($observed.spec.managementPolicies | default list))) "Delete,Observe") -}}
{{- $eligible := and $identity (not $paused) $healthy $missing (kindIs "string" $description)
  (eq (include "owned.acknowledgement-lifecycle" $observed.spec) "true")
  (eq $description (dig "status" "atProvider" "description" "" $observed)) -}}
{{- if hasKey $annotations $key -}}
{{- $hold = true -}}{{- $desired = deepCopy $preserved -}}
{{- $record := fromJson (get $annotations $key) -}}{{- $valid := and $identity (kindIs "map" $record) -}}
{{- if $valid -}}
{{- $valid = and (kindIs "string" $record.phase) (kindIs "string" $record.uid) (kindIs "string" $record.externalName)
  (kindIs "string" $record.restoreDeletionPolicy) (kindIs "slice" $record.restorePolicies)
  (kindIs "bool" $record.restoreDescriptionPresent) (kindIs "string" $record.restoreDescription)
  (kindIs "bool" $record.restorePausedPresent) (kindIs "string" $record.restorePausedValue)
  (kindIs "string" $record.probeDescription) (kindIs "string" $record.cloudSpecHash) -}}
{{- end -}}
{{- if $valid -}}
{{- $valid = and (eq (toString ($record.version | default 0)) "1") (has $record.phase (list "pause" "probe" "restore" "complete"))
  (eq $record.uid $uid) (eq $record.externalName $externalName) (ne $record.restorePausedValue "true")
  (or $record.restorePausedPresent (eq $record.restorePausedValue ""))
  (or $record.restoreDescriptionPresent (eq $record.restoreDescription ""))
  (regexMatch "^[a-f0-9]{64}$" $record.cloudSpecHash)
  (regexMatch "^[1-9][0-9]*$" (toString ($record.startedGeneration | default 0)))
  (eq (include "owned.acknowledgement-lifecycle" (dict "managementPolicies" $record.restorePolicies "deletionPolicy" $record.restoreDeletionPolicy)) "true") -}}
{{- range $field, $_ := $record -}}
{{- if not (has $field (list "version" "phase" "uid" "externalName" "restoreDescriptionPresent" "restoreDescription" "restorePolicies" "restoreDeletionPolicy" "restorePausedPresent" "restorePausedValue" "startedGeneration" "probeDescription" "cloudSpecHash" "pausedGeneration" "probeGeneration" "restoredGeneration")) -}}{{- $valid = false -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if $valid -}}
{{- $expectedProbe := include "owned.acknowledgement-probe-description" $record -}}
{{- $valid = eq $record.probeDescription $expectedProbe -}}
{{- if eq $record.phase "pause" -}}
{{- $valid = and $valid (not (hasKey $record "pausedGeneration")) (not (hasKey $record "probeGeneration")) (not (hasKey $record "restoredGeneration")) -}}
{{- else -}}
{{- $valid = and $valid (regexMatch "^[1-9][0-9]*$" (toString ($record.pausedGeneration | default 0)))
  (gt (int64 ($record.pausedGeneration | default 0)) (int64 $record.startedGeneration)) -}}
{{- if eq $record.phase "probe" -}}
{{- $valid = and $valid (not (hasKey $record "probeGeneration")) (not (hasKey $record "restoredGeneration")) -}}
{{- else -}}
{{- $valid = and $valid (regexMatch "^[1-9][0-9]*$" (toString ($record.probeGeneration | default 0)))
  (ge (int64 ($record.probeGeneration | default 0)) (int64 ($record.pausedGeneration | default 0))) -}}
{{- if eq $record.phase "restore" -}}{{- $valid = and $valid (not (hasKey $record "restoredGeneration")) -}}
{{- else -}}
{{- $valid = and $valid (regexMatch "^[1-9][0-9]*$" (toString ($record.restoredGeneration | default 0)))
  (gt (int64 ($record.restoredGeneration | default 0)) (int64 ($record.probeGeneration | default 0)))
  (le (int64 ($record.restoredGeneration | default 0)) (int64 $generation)) -}}
{{- end -}}{{- end -}}{{- end -}}
{{- end -}}
{{- if $valid -}}
{{- $recordRetiring := and (eq $record.restoreDeletionPolicy "Delete") (eq (join "," (sortAlpha $record.restorePolicies)) "Delete,Observe") -}}
{{- $retiring = or $retiring $recordRetiring -}}
{{- if eq $record.phase "complete" -}}
{{- if not $paused -}}
{{- $desired = deepCopy $selected -}}
{{- if and (not (hasKey $desired.spec.forProvider "description")) $record.restoreDescriptionPresent -}}{{- $_ := set $desired.spec.forProvider "description" $record.restoreDescription -}}{{- end -}}
{{- $desiredAnnotations := dig "metadata" "annotations" (dict) $desired -}}
{{- if and (not (hasKey $desiredAnnotations $pauseKey)) $record.restorePausedPresent -}}{{- $_ := set $desiredAnnotations $pauseKey $record.restorePausedValue -}}{{- end -}}
{{- $_ := set $desiredAnnotations $key (get $annotations $key) -}}{{- $_ := set $desired.metadata "annotations" $desiredAnnotations -}}
{{- $hold = false -}}{{- $start = $eligible -}}
{{- end -}}
{{- else if eq $hash $record.cloudSpecHash -}}
{{- $readOnlyApplied := and (eq ($observed.spec.deletionPolicy | default "") "Orphan")
  (eq (join "," (sortAlpha ($observed.spec.managementPolicies | default list))) "LateInitialize,Observe")
  $descriptionPresent (kindIs "string" $description) (eq $description $record.probeDescription)
  (gt (int64 $generation) (int64 $record.startedGeneration)) -}}
{{- $pauseRestored := and (eq $pausePresent $record.restorePausedPresent) (eq $pause $record.restorePausedValue) -}}
{{- if eq $record.phase "pause" -}}
{{- if and $readOnlyApplied $paused $pausedAck -}}
{{- if $record.restorePausedPresent -}}{{- $_ := set $desired.metadata.annotations $pauseKey $record.restorePausedValue -}}
{{- else -}}{{- $_ := unset $desired.metadata.annotations $pauseKey -}}{{- end -}}
{{- $_ := set $record "phase" "probe" -}}{{- $_ := set $record "pausedGeneration" $generation -}}
{{- $_ := set $desired.metadata.annotations $key ($record | toJson) -}}
{{- end -}}
{{- else if eq $record.phase "probe" -}}
{{- if and $readOnlyApplied $pauseRestored $current (ge (int64 $generation) (int64 $record.pausedGeneration)) -}}
{{- $_ := set $desired.spec "managementPolicies" (deepCopy $record.restorePolicies) -}}{{- $_ := set $desired.spec "deletionPolicy" $record.restoreDeletionPolicy -}}
{{- if $record.restoreDescriptionPresent -}}{{- $_ := set $desired.spec.forProvider "description" $record.restoreDescription -}}
{{- else -}}{{- $_ := unset $desired.spec.forProvider "description" -}}{{- end -}}
{{- $_ := set $record "phase" "restore" -}}{{- $_ := set $record "probeGeneration" $generation -}}
{{- $_ := set $desired.metadata.annotations $key ($record | toJson) -}}
{{- end -}}
{{- else -}}
{{- $restored := and $pauseRestored (eq ($observed.spec.deletionPolicy | default "") $record.restoreDeletionPolicy)
  (eq (toJson $observed.spec.managementPolicies) (toJson $record.restorePolicies))
  (eq $descriptionPresent $record.restoreDescriptionPresent) (kindIs "string" $description)
  (eq $description $record.restoreDescription) (gt (int64 $generation) (int64 $record.probeGeneration)) -}}
{{- if and $restored $current -}}
{{- $_ := set $record "phase" "complete" -}}{{- $_ := set $record "restoredGeneration" $generation -}}
{{- $_ := set $desired.metadata.annotations $key ($record | toJson) -}}
{{- end -}}
{{- end -}}{{- end -}}{{- end -}}
{{- else if $paused -}}{{- $hold = true -}}{{- $desired = deepCopy $preserved -}}
{{- else -}}{{- $start = $eligible -}}
{{- end -}}
{{- if $start -}}
{{- $hold = true -}}{{- $desired = deepCopy $preserved -}}
{{- $record := dict "version" 1 "phase" "pause" "uid" $uid "externalName" $externalName
  "restoreDescriptionPresent" $descriptionPresent "restoreDescription" $description
  "restorePausedPresent" $pausePresent "restorePausedValue" $pause
  "restorePolicies" (deepCopy $observed.spec.managementPolicies) "restoreDeletionPolicy" $observed.spec.deletionPolicy
  "startedGeneration" $generation "cloudSpecHash" $hash -}}
{{- $probe := include "owned.acknowledgement-probe-description" $record -}}{{- $_ := set $record "probeDescription" $probe -}}
{{- $_ := set $desired.spec "managementPolicies" (list "Observe" "LateInitialize") -}}{{- $_ := set $desired.spec "deletionPolicy" "Orphan" -}}
{{- $_ := set $desired.spec.forProvider "description" $probe -}}{{- $_ := set $desired.metadata.annotations $pauseKey "true" -}}
{{- $_ := set $desired.metadata.annotations $key ($record | toJson) -}}
{{- end -}}
{{- dict "resource" $desired "hold" $hold "retiring" $retiring | toJson -}}
{{- end -}}
{{- define "owned.acknowledgement-retiring" -}}
{{- (include "owned.acknowledgement" . | fromJson).retiring -}}
{{- end -}}
`.trim();
