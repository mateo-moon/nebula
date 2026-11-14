/** Shared guards for compositions consuming observed network resources. */
export const NETWORK_OBSERVATION_HELPERS = String.raw`
{{- define "network.ready" -}}
{{- $ready := false -}}{{- $synced := false -}}{{- $object := . -}}
{{- range (dig "status" "conditions" (list) $object) -}}
{{- if and (eq .type "Ready") (eq .status "True") -}}{{- $ready = true -}}{{- end -}}
{{- if and (eq .type "Synced") (eq .status "True") -}}{{- $synced = true -}}
{{- if hasKey . "observedGeneration" -}}{{- $synced = eq (toString .observedGeneration) (toString (dig "metadata" "generation" 0 $object)) -}}{{- end -}}
{{- end -}}{{- end -}}
{{- and $ready $synced (not (dig "metadata" "deletionTimestamp" "" $object)) -}}
{{- end -}}
{{- define "network.ipv4" -}}
{{- $valid := kindIs "string" . -}}
{{- if $valid -}}
{{- $valid = regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}$" . -}}
{{- range $octet := splitList "." . -}}
{{- if or (gt (int $octet) 255) (ne (toString (int $octet)) $octet) -}}{{- $valid = false -}}{{- end -}}
{{- end -}}
{{- if or (hasPrefix "0." .) (hasPrefix "127." .) (ge (int (first (splitList "." .))) 224) -}}{{- $valid = false -}}{{- end -}}
{{- end -}}{{- $valid -}}
{{- end -}}
{{- define "network.cidr4" -}}
{{- $valid := kindIs "string" . -}}
{{- if $valid -}}
{{- $parts := splitList "/" . -}}
{{- $valid = eq (len $parts) 2 -}}
{{- if $valid -}}
{{- $bits := last $parts -}}
{{- $valid = and (eq (include "network.ipv4" (first $parts)) "true") (regexMatch "^([1-9]|[12][0-9]|3[0-2])$" $bits) -}}
{{- if $valid -}}
{{- $address := int64 0 -}}{{- range $octet := splitList "." (first $parts) -}}{{- $address = add (mul $address 256) (int64 $octet) -}}{{- end -}}
{{- $size := int64 1 -}}{{- range untilStep (int $bits) 32 1 -}}{{- $size = mul $size 2 -}}{{- end -}}
{{- $valid = eq (mod $address $size) (int64 0) -}}
{{- end -}}
{{- end -}}{{- end -}}{{- $valid -}}
{{- end -}}
`.trim();
