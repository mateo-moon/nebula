/** Executed by function-go-templating, not by a local renderer or cloud CLI.
 * Private kubeconfig material is copied only into a Kubernetes Secret. Only a
 * strict public JWKS can reach S3. Stable object names update in place on rotation;
 * no Delete policies retain the objects. Bucket versioning is managed only when
 * explicitly enabled; the default observes its existing state without changing it. */
export const KUBERNETES_OIDC_PUBLICATION_TEMPLATE = String.raw`
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
{{- define "preserve" -}}
{{- $old := dig "resource" (dict) (get .resources .key | default dict) -}}
{{- if and $old (eq (dig "metadata" "name" "" $old) .name)
  (eq (dig "metadata" "namespace" "" $old) (.namespace | default "")) -}}
{{- $metadata := dict "name" .name "annotations" (dict "gotemplating.fn.crossplane.io/composition-resource-name" .key) -}}
{{- if .namespace -}}{{- $_ := set $metadata "namespace" .namespace -}}{{- end -}}
{{- $external := dig "metadata" "annotations" "crossplane.io/external-name" "" $old -}}
{{- if $external -}}{{- $_ := set $metadata.annotations "crossplane.io/external-name" $external -}}{{- end -}}
{{- $out := dict "apiVersion" $old.apiVersion "kind" $old.kind "metadata" $metadata -}}
{{- if eq $old.kind "Secret" -}}
{{- $_ := set $out "type" "Opaque" -}}{{- $_ := set $out "data" $old.data -}}
{{- $_ := set $metadata.annotations "gotemplating.fn.crossplane.io/ready" "True" -}}
{{- else -}}{{- $_ := set $out "spec" $old.spec -}}{{- end -}}
{{ template "emit" $out }}
{{- end -}}
{{- end -}}
{{- $spec := .observed.composite.resource.spec -}}
{{- $resources := .observed.resources | default dict -}}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" -}}
{{- $retained := list "Observe" "Create" "Update" "LateInitialize" -}}
{{- $prefix := $spec.name -}}
{{- $manageVersioning := eq ($spec.versioning | default "preserve") "enabled" -}}
{{- $versioningId := printf "%s,%s" $spec.bucketName $spec.accountId -}}
{{- $versioning := dig "resource" (dict) (get $resources "versioning" | default dict) -}}
{{- $versions := dig "status" "atProvider" "versioningConfiguration" (list) $versioning -}}
{{- $versioned := false -}}
{{- if $versions -}}{{- $versioned = eq ((index $versions 0).status | default "") "Enabled" -}}{{- end -}}
{{- $versioningReady := and (or (not $manageVersioning) $versioned) (eq (include "ready" $versioning) "true")
  (eq (dig "metadata" "annotations" "crossplane.io/external-name" "" $versioning) $versioningId)
  (eq (dig "spec" "forProvider" "expectedBucketOwner" "" $versioning) $spec.accountId)
  (eq (dig "status" "atProvider" "expectedBucketOwner" "" $versioning) $spec.accountId)
  (eq (dig "spec" "forProvider" "bucket" "" $versioning) $spec.bucketName) -}}
{{- $bucketPolicies := list "Observe" -}}
{{- if $spec.createBucket -}}{{- $bucketPolicies = $retained -}}{{- end -}}
{{- $bucket := dict "apiVersion" "s3.aws.upbound.io/v1beta1" "kind" "Bucket"
  "metadata" (dict "name" (printf "%s-bucket" $prefix) "annotations" (dict $annotation "bucket" "crossplane.io/external-name" $spec.bucketName))
  "spec" (dict "deletionPolicy" "Orphan" "managementPolicies" $bucketPolicies "providerConfigRef" (dict "name" $spec.awsProviderConfigName)
    "forProvider" (dict "region" $spec.region "forceDestroy" false "tags" ($spec.tags | default dict))) -}}
{{ template "emit" $bucket }}
{{- range $key, $kind := dict "versioning" "BucketVersioning" "public-access" "BucketPublicAccessBlock" -}}
{{- $for := dict "region" $spec.region "bucket" $spec.bucketName -}}
{{- $policies := $retained -}}
{{- $externalName := $spec.bucketName -}}
{{- if eq $key "versioning" -}}
{{- $externalName = $versioningId -}}
{{- $_ := set $for "expectedBucketOwner" $spec.accountId -}}
{{- if $manageVersioning -}}
{{- $_ := set $for "versioningConfiguration" (list (dict "status" "Enabled")) -}}
{{- else -}}{{- $policies = list "Observe" -}}{{- end -}}
{{- else -}}
{{- $_ := set $for "blockPublicAcls" true -}}{{- $_ := set $for "ignorePublicAcls" true -}}
{{- $_ := set $for "blockPublicPolicy" false -}}{{- $_ := set $for "restrictPublicBuckets" false -}}
{{- end -}}
{{- if or (eq $key "versioning") $versioningReady -}}
{{ template "emit" (dict "apiVersion" "s3.aws.upbound.io/v1beta1" "kind" $kind
  "metadata" (dict "name" (printf "%s-%s" $prefix $key) "annotations" (dict $annotation $key "crossplane.io/external-name" $externalName))
  "spec" (dict "deletionPolicy" "Orphan" "managementPolicies" $policies "providerConfigRef" (dict "name" $spec.awsProviderConfigName) "forProvider" $for)) }}
{{- else -}}
{{ template "preserve" (dict "resources" $resources "key" $key "name" (printf "%s-%s" $prefix $key)) }}
{{- end -}}
{{- end -}}
{{- $access := dig "resource" (dict) (get $resources "public-access" | default dict) -}}
{{- $accessReady := eq (include "ready" $access) "true" -}}
{{- $policyName := printf "%s-policy" $prefix -}}
{{- if and $accessReady $versioningReady -}}
{{- $policy := dict "Version" "2012-10-17" "Statement" (list (dict "Sid" "PublicOidcDiscovery" "Effect" "Allow"
  "Principal" "*" "Action" "s3:GetObject" "Resource" (list (printf "arn:aws:s3:::%s/.well-known/openid-configuration" $spec.bucketName) (printf "arn:aws:s3:::%s/keys.json" $spec.bucketName))
  "Condition" (dict "Bool" (dict "aws:SecureTransport" "true")))) -}}
{{ template "emit" (dict "apiVersion" "s3.aws.upbound.io/v1beta1" "kind" "BucketPolicy"
  "metadata" (dict "name" $policyName "annotations" (dict $annotation "policy" "crossplane.io/external-name" $spec.bucketName))
  "spec" (dict "deletionPolicy" "Orphan" "managementPolicies" $retained "providerConfigRef" (dict "name" $spec.awsProviderConfigName)
    "forProvider" (dict "region" $spec.region "bucket" $spec.bucketName "policy" ($policy | toJson)))) }}
{{- else -}}
{{ template "preserve" (dict "resources" $resources "key" "policy" "name" $policyName) }}
{{- end -}}

{{- $source := dig "resource" "status" "atProvider" "manifest" (dict) (get $resources "kubeconfig" | default dict) -}}
{{- $encoded := get ($source.data | default dict) $spec.sourceSecretKey -}}
{{- $credentials := false -}}{{- $server := "" -}}{{- $ca := "" -}}{{- $cert := "" -}}{{- $key := "" -}}
{{- if and $encoded (eq (include "ready" (dig "resource" (dict) (get $resources "kubeconfig" | default dict))) "true")
  (eq (get $source "apiVersion") "v1") (eq (get $source "kind") "Secret")
  (eq (dig "metadata" "name" "" $source) $spec.sourceSecretName) (eq (dig "metadata" "namespace" "" $source) $spec.sourceSecretNamespace) -}}
{{- $config := $encoded | b64dec | fromYaml -}}
{{- if kindIs "map" $config -}}
{{- $context := dict -}}{{- $cluster := dict -}}{{- $user := dict -}}
{{- range ($config.contexts | default list) -}}{{- if eq .name (get $config "current-context") -}}{{- $context = .context -}}{{- end -}}{{- end -}}
{{- range ($config.clusters | default list) -}}{{- if eq .name ($context.cluster | default "") -}}{{- $cluster = .cluster -}}{{- end -}}{{- end -}}
{{- range ($config.users | default list) -}}{{- if eq .name ($context.user | default "") -}}{{- $user = .user -}}{{- end -}}{{- end -}}
{{- $server = $spec.apiServerUrl | default $cluster.server | default "" -}}
{{- $ca = get $cluster "certificate-authority-data" | default "" -}}
{{- $cert = get $user "client-certificate-data" | default "" -}}{{- $key = get $user "client-key-data" | default "" -}}
{{- $credentials = and (regexMatch "^https://[A-Za-z0-9.-]+(:[0-9]+)?$" $server)
  (not (get $cluster "insecure-skip-tls-verify"))
  (hasPrefix "-----BEGIN CERTIFICATE-----" ($ca | b64dec))
  (hasPrefix "-----BEGIN CERTIFICATE-----" ($cert | b64dec))
  (regexMatch "^-----BEGIN (RSA |EC )?PRIVATE KEY-----" ($key | b64dec)) -}}
{{- end -}}
{{- end -}}
{{- $tlsName := printf "%s-api-tls" $prefix -}}{{- $requestName := printf "%s-jwks" $prefix -}}
{{- if $credentials -}}
{{ template "emit" (dict "apiVersion" "v1" "kind" "Secret" "type" "Opaque"
  "metadata" (dict "name" $tlsName "namespace" $spec.tlsSecretNamespace "annotations" (dict $annotation "api-tls" "gotemplating.fn.crossplane.io/ready" "True"))
  "data" (dict "ca.crt" $ca "tls.crt" $cert "tls.key" $key)) }}
{{- $refs := dict -}}
{{- range $field, $key := dict "caCertSecretRef" "ca.crt" "clientCertSecretRef" "tls.crt" "clientKeySecretRef" "tls.key" -}}
{{- $_ := set $refs $field (dict "name" $tlsName "namespace" $spec.tlsSecretNamespace "key" $key) -}}
{{- end -}}
{{ template "emit" (dict "apiVersion" "http.crossplane.io/v1alpha2" "kind" "Request"
  "metadata" (dict "name" $requestName "annotations" (dict $annotation "jwks"))
  "spec" (dict "deletionPolicy" "Orphan" "managementPolicies" (list "Observe" "Create")
    "providerConfigRef" (dict "name" $spec.httpProviderConfigName)
    "forProvider" (dict "tlsConfig" $refs "waitTimeout" "30s" "headers" (dict "Accept" (list "application/json"))
      "payload" (dict "baseUrl" (printf "%s/openid/v1/jwks" $server) "body" "{}")
      "mappings" (list (dict "action" "CREATE" "method" "GET" "url" ".payload.baseUrl") (dict "action" "OBSERVE" "method" "GET" "url" ".payload.baseUrl"))
      "expectedResponseCheck" (dict "type" "CUSTOM" "logic" ".response.statusCode == 200")))) }}
{{- else -}}
{{ template "preserve" (dict "resources" $resources "key" "api-tls" "name" $tlsName "namespace" $spec.tlsSecretNamespace) }}
{{ template "preserve" (dict "resources" $resources "key" "jwks" "name" $requestName) }}
{{- end -}}

{{- $request := dig "resource" (dict) (get $resources "jwks" | default dict) -}}
{{- $response := dig "status" "response" (dict) $request -}}
{{- $valid := and $credentials (eq (include "ready" $request) "true")
  (eq (dig "status" "requestDetails" "method" "" $request) "GET")
  (eq (dig "status" "requestDetails" "url" "" $request) (printf "%s/openid/v1/jwks" $server))
  (eq (toString ($response.statusCode | default 0)) "200") -}}
{{- $jwks := dict -}}
{{- if $valid -}}
{{- $body := $response.body | default "" -}}
{{- $valid = and (le (len $body) 16384) (kindIs "map" ($body | fromJson)) -}}
{{- if $valid -}}
{{- $jwks = $body | fromJson -}}
{{- $valid = and (eq (len $jwks) 1) (kindIs "slice" $jwks.keys) -}}
{{- if $valid -}}{{- $valid = and (ge (len $jwks.keys) 1) (le (len $jwks.keys) 8) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if $valid -}}
{{- $kids := dict -}}
{{- range $jwk := $jwks.keys -}}
{{- if not (kindIs "map" $jwk) -}}{{- $valid = false -}}
{{- else -}}
{{- if ne (len $jwk) 6 -}}{{- $valid = false -}}{{- end -}}
{{- range $field := list "kty" "kid" "alg" "use" "n" "e" -}}{{- if not (kindIs "string" (get $jwk $field)) -}}{{- $valid = false -}}{{- end -}}{{- end -}}
{{- if $valid -}}
{{- $valid = and (eq $jwk.kty "RSA") (eq $jwk.alg "RS256") (eq $jwk.use "sig")
  (regexMatch "^[A-Za-z0-9_-]{1,128}$" $jwk.kid) (not (hasKey $kids $jwk.kid)) -}}
{{- $_ := set $kids $jwk.kid true -}}
{{- range $field := list "n" "e" -}}
{{- $value := get $jwk $field -}}
{{- if not (regexMatch "^[A-Za-z0-9_-]+$" $value) -}}{{- $valid = false -}}
{{- else -}}
{{- $padding := mod (sub 4 (mod (len $value) 4)) 4 | int -}}
{{- $decoded := printf "%s%s" ($value | replace "-" "+" | replace "_" "/") (repeat $padding "=") | b64dec -}}
{{- $canonical := $decoded | b64enc | replace "+" "-" | replace "/" "_" | trimSuffix "=" | trimSuffix "=" -}}
{{- if ne $canonical $value -}}{{- $valid = false -}}{{- end -}}
{{- if eq $field "n" -}}
{{- /* Canonical unsigned RSA modulus, 2048–8192 bits. At the lower bound the high bit must be set. */ -}}
{{- if not (and (ge (len $decoded) 256) (le (len $decoded) 1024)
  (not (regexMatch "^A[A-P]" $value)) (or (gt (len $decoded) 256) (regexMatch "^[g-z0-9_-]" $value))) -}}{{- $valid = false -}}{{- end -}}
{{- else -}}
{{- /* Canonical positive odd exponent in the supported signed 32-bit range. */ -}}
{{- $exponent := printf "0x%x" $decoded | int64 -}}
{{- if not (and (le (len $decoded) 4) (not (regexMatch "^A[A-P]" $value))
  (ge $exponent 3) (le $exponent 2147483647) (eq (mod $exponent 2) 1)) -}}{{- $valid = false -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $valid = and $valid $accessReady $versioningReady
  (eq (include "ready" (dig "resource" (dict) (get $resources "policy" | default dict))) "true")
  (eq (include "ready" (dig "resource" (dict) (get $resources "bucket" | default dict))) "true") -}}
{{- $discovery := dict "issuer" $spec.issuerUrl "jwks_uri" (printf "%s/keys.json" $spec.issuerUrl)
  "response_types_supported" (list "id_token") "subject_types_supported" (list "public") "id_token_signing_alg_values_supported" (list "RS256") -}}
{{- $metadata := $spec.discovery | default dict -}}
{{- if $metadata.authorizationEndpoint -}}{{- $_ := set $discovery "authorization_endpoint" $metadata.authorizationEndpoint -}}{{- end -}}
{{- if $metadata.claimsSupported -}}{{- $_ := set $discovery "claims_supported" $metadata.claimsSupported -}}{{- end -}}
{{- range $key, $path := dict "discovery" ".well-known/openid-configuration" "keys" "keys.json" -}}
{{- $name := printf "%s-%s" $prefix $key -}}
{{- if $valid -}}
{{- $content := $discovery | toJson -}}{{- if eq $key "keys" -}}{{- $content = $jwks | toJson -}}{{- end -}}
{{ template "emit" (dict "apiVersion" "s3.aws.upbound.io/v1beta1" "kind" "Object"
  "metadata" (dict "name" $name "annotations" (dict $annotation $key "crossplane.io/external-name" (printf "%s/%s" $spec.bucketName $path)))
  "spec" (dict "deletionPolicy" "Orphan" "managementPolicies" $retained "providerConfigRef" (dict "name" $spec.awsProviderConfigName)
    "forProvider" (dict "region" $spec.region "bucket" $spec.bucketName "key" $path "content" $content
      "sourceHash" ($content | sha256sum) "contentType" "application/json" "cacheControl" "max-age=300" "forceDestroy" false))) }}
{{- else -}}
{{ template "preserve" (dict "resources" $resources "key" $key "name" $name) }}
{{- end -}}
{{- end -}}
{{ template "emit" (dict "apiVersion" "kubernetes.crossplane.io/v1alpha2" "kind" "Object"
  "metadata" (dict "name" (printf "%s-kubeconfig" $prefix) "annotations" (dict $annotation "kubeconfig" "gotemplating.fn.crossplane.io/ready" (ternary "True" "False" $valid)))
  "spec" (dict "managementPolicies" (list "Observe") "providerConfigRef" (dict "name" $spec.kubeProviderConfigName)
    "forProvider" (dict "manifest" (dict "apiVersion" "v1" "kind" "Secret" "metadata" (dict "name" $spec.sourceSecretName "namespace" $spec.sourceSecretNamespace))))) }}
{{ template "emit" (dict "apiVersion" "nebula.io/v1alpha1" "kind" "XAwsKubernetesOidcPublication" "status" (dict "publicationReady" $valid)) }}
`.trim();
