/**
 * Existing-object S3 replication through a Crossplane composite resource.
 *
 * S3 replication rules only replicate objects written after the rule becomes
 * active. AWS's `ExistingObjectReplication` API field is no longer supported;
 * the supported backfill mechanism is an S3 Batch Replication job. The Upbound
 * AWS provider does not expose S3 Batch Operations jobs, so this composition
 * gives the one-shot action a declarative, observable lifecycle:
 *
 * - two least-privilege IAM roles are reconciled by provider-aws;
 * - a narrowly-bound ServiceAccount obtains temporary AWS credentials through
 *   the cluster's OIDC issuer;
 * - a retained Kubernetes Job waits for the exact replication rule and the
 *   destination's minimum COMPLIANCE Object Lock retention, then creates and
 *   follows the S3 Batch job;
 * - the XR remains not-ready until the Job succeeds and exposes its phase in
 *   status. A failed Job stays in the cluster for inspection.
 *
 * Split into two constructs:
 * - `S3BatchReplicationSetup` installs the cluster-wide XRD, Composition, and
 *   Crossplane aggregate RBAC (once per management cluster).
 * - `S3BatchReplication` creates one immutable XR per explicit Git-controlled
 *   run. To retry deliberately, create a new XR with a new `name` and `runId`.
 *
 * Prerequisites:
 * - Crossplane v2;
 * - provider-aws IAM family;
 * - function-go-templating v0.9.0;
 * - a ready S3 replication rule from source to destination;
 * - destination Object Lock with COMPLIANCE default retention;
 * - an existing report bucket.
 */
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { ARGOCD_SYNC_WAVE_ANNOTATION } from "../../../core";

export const S3_BATCH_REPLICATION_COMPOSITION_NAME =
  "s3-batch-replication";

const DEFAULT_AWS_CLI_IMAGE =
  "public.ecr.aws/aws-cli/aws-cli:2.31.18@sha256:d3f5b7078a71fd7cb488719571c50abd252f4320cdf375601f2d6d40caf97b55";

export interface S3BatchReplicationConfig {
  /**
   * DNS-safe name of this immutable backfill run. Use a new name for a retry.
   * It becomes the XR name and is included in deterministic child names.
   */
  name: string;
  /** AWS account that owns the source bucket and runs the Batch job. */
  accountId: string;
  /** Source bucket whose eligible existing versions must be replicated. */
  sourceBucket: string;
  /** Region of the source bucket. S3 Batch Replication is started here. */
  sourceRegion: string;
  /** Destination bucket configured on the selected replication rule. */
  destinationBucket: string;
  /** Region of the destination bucket, used for Object Lock verification. */
  destinationRegion: string;
  /**
   * Minimum destination COMPLIANCE default retention required before the
   * Batch job may start (default 90 days).
   */
  minimumObjectLockRetentionDays?: number;
  /** Stable ID of the enabled S3 replication rule to verify before starting. */
  replicationRuleId: string;
  /** Existing S3 bucket that receives the Batch Operations completion report. */
  reportBucket: string;
  /**
   * Prefix for the completion report. Defaults to
   * `nebula/s3-batch-replication/<name>/<runId>`.
   */
  reportPrefix?: string;
  /**
   * Immutable, human-readable revision recorded in Git. It participates in the
   * AWS idempotency token; changing it requires replacing the XR.
   */
  runId: string;
  /**
   * HTTPS issuer URL of the cluster's IAM OIDC provider, for example
   * `https://example-issuer.s3.eu-central-1.amazonaws.com`.
   */
  oidcIssuerUrl: string;
  /** Namespace for the composed ServiceAccount and Job (default crossplane-system). */
  namespace?: string;
  /** provider-aws ProviderConfig name (default default). */
  providerConfigRef?: string;
  /** Relative S3 Batch Operations priority (default 10). */
  priority?: number;
  /** Seconds between DescribeJob calls (default 30). */
  pollIntervalSeconds?: number;
  /** Maximum Kubernetes Job duration (default 7 days). */
  activeDeadlineSeconds?: number;
  /** Versioned or digest-pinned AWS CLI v2 image. */
  jobImage?: string;
  /** ArgoCD sync wave for the XR (default 5). */
  syncWave?: string;
}

/**
 * Installs the shared XS3BatchReplication API and its Composition.
 * Instantiate once per Crossplane management cluster.
 */
export class S3BatchReplicationSetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly composedResourcesRbac: ApiObject;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.composedResourcesRbac = this.createComposedResourcesRbac();
    this.xrd = this.createXrd();
    this.composition = this.createComposition();
  }

  /**
   * Crossplane v2 can compose native Kubernetes resources, but Crossplane core
   * must be granted their API permissions. The rbac-manager aggregates this
   * role into Crossplane's own role. No workload permissions are granted here.
   */
  private createComposedResourcesRbac(): ApiObject {
    return new ApiObject(this, "composed-resources-rbac", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: {
        name: "crossplane-s3-batch-replication-composed-resources",
        annotations: {
          [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10",
        },
        labels: {
          "rbac.crossplane.io/aggregate-to-crossplane": "true",
        },
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["serviceaccounts"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
        {
          apiGroups: ["batch"],
          resources: ["jobs"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
      ],
    });
  }

  private createXrd(): CompositeResourceDefinitionV2 {
    return new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xs3batchreplications.nebula.io",
        annotations: {
          [ARGOCD_SYNC_WAVE_ANNOTATION]: "-10",
        },
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XS3BatchReplication",
          plural: "xs3batchreplications",
        },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        defaultCompositionRef: {
          name: S3_BATCH_REPLICATION_COMPOSITION_NAME,
        },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    "x-kubernetes-validations": [
                      {
                        rule:
                          "self.accountId == oldSelf.accountId && self.sourceBucket == oldSelf.sourceBucket && self.sourceRegion == oldSelf.sourceRegion && self.destinationBucket == oldSelf.destinationBucket && self.destinationRegion == oldSelf.destinationRegion && self.minimumObjectLockRetentionDays == oldSelf.minimumObjectLockRetentionDays && self.replicationRuleId == oldSelf.replicationRuleId && self.reportBucket == oldSelf.reportBucket && self.reportPrefix == oldSelf.reportPrefix && self.runId == oldSelf.runId && self.oidcIssuerUrl == oldSelf.oidcIssuerUrl && self.namespace == oldSelf.namespace && self.providerConfigRef == oldSelf.providerConfigRef && self.priority == oldSelf.priority && self.pollIntervalSeconds == oldSelf.pollIntervalSeconds && self.activeDeadlineSeconds == oldSelf.activeDeadlineSeconds && self.jobImage == oldSelf.jobImage",
                        message:
                          "S3 Batch Replication run inputs are immutable; create a new XR for a new run",
                      },
                    ],
                    required: [
                      "accountId",
                      "sourceBucket",
                      "sourceRegion",
                      "destinationBucket",
                      "destinationRegion",
                      "minimumObjectLockRetentionDays",
                      "replicationRuleId",
                      "reportBucket",
                      "reportPrefix",
                      "runId",
                      "oidcIssuerUrl",
                      "namespace",
                      "providerConfigRef",
                      "priority",
                      "pollIntervalSeconds",
                      "activeDeadlineSeconds",
                      "jobImage",
                    ],
                    properties: {
                      accountId: {
                        type: "string",
                        pattern: "^[0-9]{12}$",
                        description: "AWS account that owns the source bucket",
                      },
                      sourceBucket: {
                        type: "string",
                        minLength: 3,
                        maxLength: 63,
                        pattern:
                          "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$",
                      },
                      sourceRegion: {
                        type: "string",
                        pattern: "^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$",
                      },
                      destinationBucket: {
                        type: "string",
                        minLength: 3,
                        maxLength: 63,
                        pattern:
                          "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$",
                      },
                      destinationRegion: {
                        type: "string",
                        pattern: "^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$",
                      },
                      minimumObjectLockRetentionDays: {
                        type: "integer",
                        format: "int32",
                        minimum: 1,
                        default: 90,
                        description:
                          "Minimum destination COMPLIANCE default retention in days",
                      },
                      replicationRuleId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 255,
                        pattern: "^[A-Za-z0-9._-]+$",
                      },
                      reportBucket: {
                        type: "string",
                        minLength: 3,
                        maxLength: 63,
                        pattern:
                          "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$",
                      },
                      reportPrefix: {
                        type: "string",
                        minLength: 1,
                        maxLength: 512,
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$",
                      },
                      runId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 63,
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
                        description:
                          "Immutable Git-controlled backfill revision",
                        "x-kubernetes-validations": [
                          {
                            rule: "self == oldSelf",
                            message:
                              "runId is immutable; create a new XR for a new run",
                          },
                        ],
                      },
                      oidcIssuerUrl: {
                        type: "string",
                        maxLength: 255,
                        pattern: "^https://[^/]+(?:/[^/]+)*$",
                      },
                      namespace: {
                        type: "string",
                        minLength: 1,
                        maxLength: 63,
                        pattern:
                          "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
                        default: "crossplane-system",
                      },
                      providerConfigRef: {
                        type: "string",
                        minLength: 1,
                        default: "default",
                      },
                      priority: {
                        type: "integer",
                        format: "int32",
                        minimum: 0,
                        maximum: 2147483647,
                        default: 10,
                      },
                      pollIntervalSeconds: {
                        type: "integer",
                        format: "int32",
                        minimum: 5,
                        maximum: 300,
                        default: 30,
                      },
                      activeDeadlineSeconds: {
                        type: "integer",
                        format: "int64",
                        minimum: 300,
                        maximum: 2592000,
                        default: 604800,
                      },
                      jobImage: {
                        type: "string",
                        minLength: 1,
                        pattern: "^[^[:space:]]+$",
                        default: DEFAULT_AWS_CLI_IMAGE,
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      phase: {
                        type: "string",
                        enum: [
                          "WaitingForInfrastructure",
                          "Pending",
                          "Running",
                          "Succeeded",
                          "Failed",
                        ],
                      },
                      jobName: { type: "string" },
                      reportUri: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
  }

  private createComposition(): Composition {
    return new Composition(this, "composition", {
      metadata: {
        name: S3_BATCH_REPLICATION_COMPOSITION_NAME,
        annotations: {
          [ARGOCD_SYNC_WAVE_ANNOTATION]: "-5",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XS3BatchReplication",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "render-s3-batch-replication",
            functionRef: {
              name: "function-go-templating",
            },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: {
                template: this.compositionTemplate(),
              },
            },
          },
        ],
      },
    });
  }

  private compositionTemplate(): string {
    return `
{{- $xr := .observed.composite.resource -}}
{{- $spec := $xr.spec -}}
{{- $xrName := $xr.metadata.name -}}
{{- $runHash := (printf "%s/%s" $xrName $spec.runId | sha256sum | trunc 8) -}}
{{- $nameBase := ($xrName | trunc 40 | trimSuffix "-") -}}
{{- $batchRoleName := printf "%s-batch-role-%s" $nameBase $runHash -}}
{{- $batchPolicyName := printf "%s-batch-policy-%s" $nameBase $runHash -}}
{{- $executorRoleName := printf "%s-exec-role-%s" $nameBase $runHash -}}
{{- $executorPolicyName := printf "%s-exec-policy-%s" $nameBase $runHash -}}
{{- $serviceAccountName := printf "s3-batch-%s" $runHash -}}
{{- $jobName := printf "%s-%s" ($xrName | trunc 49 | trimSuffix "-") $runHash -}}
{{- $issuer := trimPrefix "https://" $spec.oidcIssuerUrl -}}
{{- $oidcProviderArn := printf "arn:aws:iam::%s:oidc-provider/%s" $spec.accountId $issuer -}}
{{- $batchRoleArn := printf "arn:aws:iam::%s:role/%s" $spec.accountId $batchRoleName -}}
{{- $executorRoleArn := printf "arn:aws:iam::%s:role/%s" $spec.accountId $executorRoleName -}}
{{- $sourceBucketArn := printf "arn:aws:s3:::%s" $spec.sourceBucket -}}
{{- $destinationBucketArn := printf "arn:aws:s3:::%s" $spec.destinationBucket -}}
{{- $reportObjectArn := printf "arn:aws:s3:::%s/%s/*" $spec.reportBucket (trimSuffix "/" $spec.reportPrefix) -}}
{{- $clientRequestToken := printf "%s/%s" $xrName $spec.runId | sha256sum -}}
{{- $observedResources := default (dict) .observed.resources -}}
{{- $ready := dict "iam" true "jobComplete" false "jobFailed" false -}}
{{- range $resourceName := list "batch-role" "batch-policy" "batch-policy-attachment" "executor-role" "executor-policy" "executor-policy-attachment" -}}
  {{- $resourceReady := false -}}
  {{- $observed := index $observedResources $resourceName -}}
  {{- if $observed -}}
    {{- range $condition := $observed.resource.status.conditions -}}
      {{- if and (eq $condition.type "Ready") (eq $condition.status "True") -}}
        {{- $resourceReady = true -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if not $resourceReady -}}
    {{- $_ := set $ready "iam" false -}}
  {{- end -}}
{{- end -}}
{{- $serviceAccountObserved := index $observedResources "service-account" -}}
{{- if not $serviceAccountObserved -}}
  {{- $_ := set $ready "iam" false -}}
{{- end -}}
{{- $observedJob := index $observedResources "batch-job" -}}
{{- if $observedJob -}}
  {{- range $condition := $observedJob.resource.status.conditions -}}
    {{- if and (eq $condition.type "Complete") (eq $condition.status "True") -}}
      {{- $_ := set $ready "jobComplete" true -}}
    {{- end -}}
    {{- if and (eq $condition.type "Failed") (eq $condition.status "True") -}}
      {{- $_ := set $ready "jobFailed" true -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: Role
metadata:
  name: {{ $batchRoleName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: batch-role
    crossplane.io/external-name: {{ $batchRoleName }}
spec:
  forProvider:
    assumeRolePolicy: {{ dict "Version" "2012-10-17" "Statement" (list (dict "Effect" "Allow" "Principal" (dict "Service" "batchoperations.s3.amazonaws.com") "Action" "sts:AssumeRole")) | toJson | quote }}
    description: {{ printf "S3 Batch Replication service role for %s" $xrName | quote }}
    tags:
      nebula.sh/managed-by: nebula
      nebula.sh/purpose: s3-batch-replication
      nebula.sh/run-hash: {{ $runHash }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: Policy
metadata:
  name: {{ $batchPolicyName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: batch-policy
    crossplane.io/external-name: {{ $batchPolicyName }}
spec:
  forProvider:
    description: {{ printf "Least-privilege S3 Batch Replication policy for %s" $xrName | quote }}
    policy: {{ dict "Version" "2012-10-17" "Statement" (list (dict "Sid" "InitiateReplication" "Effect" "Allow" "Action" (list "s3:InitiateReplication") "Resource" (printf "%s/*" $sourceBucketArn)) (dict "Sid" "GeneratedManifest" "Effect" "Allow" "Action" (list "s3:GetReplicationConfiguration" "s3:PutInventoryConfiguration") "Resource" $sourceBucketArn) (dict "Sid" "CompletionReport" "Effect" "Allow" "Action" (list "s3:PutObject") "Resource" $reportObjectArn)) | toJson | quote }}
    tags:
      nebula.sh/managed-by: nebula
      nebula.sh/purpose: s3-batch-replication
      nebula.sh/run-hash: {{ $runHash }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: RolePolicyAttachment
metadata:
  name: {{ printf "%s-attach" $batchPolicyName | trunc 63 | trimSuffix "-" }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: batch-policy-attachment
spec:
  forProvider:
    policyArnRef:
      name: {{ $batchPolicyName }}
    roleRef:
      name: {{ $batchRoleName }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: Role
metadata:
  name: {{ $executorRoleName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: executor-role
    crossplane.io/external-name: {{ $executorRoleName }}
spec:
  forProvider:
    assumeRolePolicy: {{ dict "Version" "2012-10-17" "Statement" (list (dict "Effect" "Allow" "Principal" (dict "Federated" $oidcProviderArn) "Action" "sts:AssumeRoleWithWebIdentity" "Condition" (dict "StringEquals" (dict (printf "%s:aud" $issuer) "sts.amazonaws.com" (printf "%s:sub" $issuer) (printf "system:serviceaccount:%s:%s" $spec.namespace $serviceAccountName))))) | toJson | quote }}
    description: {{ printf "WebIdentity executor for S3 Batch Replication %s" $xrName | quote }}
    tags:
      nebula.sh/managed-by: nebula
      nebula.sh/purpose: s3-batch-replication-executor
      nebula.sh/run-hash: {{ $runHash }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: Policy
metadata:
  name: {{ $executorPolicyName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: executor-policy
    crossplane.io/external-name: {{ $executorPolicyName }}
spec:
  forProvider:
    description: {{ printf "Create and observe only the scoped S3 Batch Replication job for %s" $xrName | quote }}
    policy: {{ dict "Version" "2012-10-17" "Statement" (list (dict "Sid" "CreateBatchJob" "Effect" "Allow" "Action" (list "s3:CreateJob") "Resource" "*") (dict "Sid" "DescribeBatchJob" "Effect" "Allow" "Action" (list "s3:DescribeJob") "Resource" (printf "arn:aws:s3:*:%s:job/*" $spec.accountId)) (dict "Sid" "VerifyReplicationRule" "Effect" "Allow" "Action" (list "s3:GetReplicationConfiguration") "Resource" $sourceBucketArn) (dict "Sid" "VerifyDestinationObjectLock" "Effect" "Allow" "Action" (list "s3:GetBucketObjectLockConfiguration") "Resource" $destinationBucketArn) (dict "Sid" "PassOnlyBatchRole" "Effect" "Allow" "Action" (list "iam:PassRole") "Resource" $batchRoleArn "Condition" (dict "StringEquals" (dict "iam:PassedToService" "batchoperations.s3.amazonaws.com")))) | toJson | quote }}
    tags:
      nebula.sh/managed-by: nebula
      nebula.sh/purpose: s3-batch-replication-executor
      nebula.sh/run-hash: {{ $runHash }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: RolePolicyAttachment
metadata:
  name: {{ printf "%s-attach" $executorPolicyName | trunc 63 | trimSuffix "-" }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: executor-policy-attachment
spec:
  forProvider:
    policyArnRef:
      name: {{ $executorPolicyName }}
    roleRef:
      name: {{ $executorRoleName }}
  providerConfigRef:
    name: {{ $spec.providerConfigRef }}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ $serviceAccountName }}
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: service-account
    gotemplating.fn.crossplane.io/ready: "True"
    nebula.sh/aws-role-arn: {{ $executorRoleArn }}
  labels:
    app.kubernetes.io/name: s3-batch-replication
    app.kubernetes.io/managed-by: crossplane
    nebula.sh/run-hash: {{ $runHash }}
automountServiceAccountToken: false
{{- if or (get $ready "iam") $observedJob }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ $jobName }}
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: batch-job
    {{- if get $ready "jobComplete" }}
    gotemplating.fn.crossplane.io/ready: "True"
    {{- end }}
    nebula.sh/run-id: {{ $spec.runId | quote }}
  labels:
    app.kubernetes.io/name: s3-batch-replication
    app.kubernetes.io/managed-by: crossplane
    nebula.sh/run-hash: {{ $runHash }}
spec:
  backoffLimit: 3
  activeDeadlineSeconds: {{ $spec.activeDeadlineSeconds }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: s3-batch-replication
        nebula.sh/run-hash: {{ $runHash }}
    spec:
      serviceAccountName: {{ $serviceAccountName }}
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: backfill
          image: {{ $spec.jobImage }}
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-ec"]
          args:
            - |
              rule_query="ReplicationConfiguration.Rules[?ID=='$REPLICATION_RULE_ID'] | [0]"
              echo "Waiting for replication rule and destination Object Lock readiness"
              while true; do
                replication_ready=false
                object_lock_ready=false
                rule_destination=""
                rule_status=""
                object_lock_enabled=""
                object_lock_mode=""
                object_lock_days=""

                if rule_destination=$(aws s3api get-bucket-replication \
                  --bucket "$SOURCE_BUCKET" \
                  --region "$SOURCE_REGION" \
                  --query "$rule_query.Destination.Bucket" \
                  --output text 2>&1) && \
                  rule_status=$(aws s3api get-bucket-replication \
                    --bucket "$SOURCE_BUCKET" \
                    --region "$SOURCE_REGION" \
                    --query "$rule_query.Status" \
                    --output text 2>&1); then
                  if [ "$rule_destination" = "arn:aws:s3:::$DESTINATION_BUCKET" ] && \
                    [ "$rule_status" = "Enabled" ]; then
                    replication_ready=true
                  else
                    echo "Replication rule not ready: destination=$rule_destination status=$rule_status"
                  fi
                else
                  echo "Replication configuration is not readable yet: $rule_destination $rule_status"
                fi

                if object_lock_enabled=$(aws s3api get-object-lock-configuration \
                  --bucket "$DESTINATION_BUCKET" \
                  --region "$DESTINATION_REGION" \
                  --query ObjectLockConfiguration.ObjectLockEnabled \
                  --output text 2>&1) && \
                  object_lock_mode=$(aws s3api get-object-lock-configuration \
                    --bucket "$DESTINATION_BUCKET" \
                    --region "$DESTINATION_REGION" \
                    --query ObjectLockConfiguration.Rule.DefaultRetention.Mode \
                    --output text 2>&1) && \
                  object_lock_days=$(aws s3api get-object-lock-configuration \
                    --bucket "$DESTINATION_BUCKET" \
                    --region "$DESTINATION_REGION" \
                    --query ObjectLockConfiguration.Rule.DefaultRetention.Days \
                    --output text 2>&1); then
                  case "$object_lock_days" in
                    ''|None|*[!0-9]*)
                      echo "Destination Object Lock retention is not ready: days=$object_lock_days"
                      ;;
                    *)
                      if [ "$object_lock_enabled" = "Enabled" ] && \
                        [ "$object_lock_mode" = "COMPLIANCE" ] && \
                        [ "$object_lock_days" -ge "$MINIMUM_OBJECT_LOCK_RETENTION_DAYS" ]; then
                        object_lock_ready=true
                      else
                        echo "Destination Object Lock not ready: enabled=$object_lock_enabled mode=$object_lock_mode days=$object_lock_days required=$MINIMUM_OBJECT_LOCK_RETENTION_DAYS"
                      fi
                      ;;
                  esac
                else
                  echo "Destination Object Lock configuration is not readable yet: $object_lock_enabled $object_lock_mode $object_lock_days"
                fi

                if [ "$replication_ready" = "true" ] && [ "$object_lock_ready" = "true" ]; then
                  echo "Replication rule and destination Object Lock are ready"
                  break
                fi

                sleep "$POLL_INTERVAL_SECONDS"
              done

              report_configuration=$(printf '{"Bucket":"arn:aws:s3:::%s","Prefix":"%s","Format":"Report_CSV_20180820","Enabled":true,"ReportScope":"AllTasks"}' "$REPORT_BUCKET" "$REPORT_PREFIX")
              # COMPLETED deliberately re-replicates any version copied before
              # destination COMPLIANCE lock became ready. The readiness loop
              # above guarantees its replacement replica is locked.
              manifest_generator=$(printf '{"S3JobManifestGenerator":{"ExpectedBucketOwner":"%s","SourceBucket":"arn:aws:s3:::%s","EnableManifestOutput":false,"Filter":{"EligibleForReplication":true,"ObjectReplicationStatuses":["NONE","FAILED","COMPLETED"]}}}' "$ACCOUNT_ID" "$SOURCE_BUCKET")

              job_id=$(aws s3control create-job \
                --account-id "$ACCOUNT_ID" \
                --operation '{"S3ReplicateObject":{}}' \
                --report "$report_configuration" \
                --manifest-generator "$manifest_generator" \
                --priority "$PRIORITY" \
                --role-arn "$BATCH_ROLE_ARN" \
                --client-request-token "$CLIENT_REQUEST_TOKEN" \
                --no-confirmation-required \
                --region "$SOURCE_REGION" \
                --query JobId \
                --output text)

              echo "Following S3 Batch Replication job $job_id"
              while true; do
                status=$(aws s3control describe-job \
                  --account-id "$ACCOUNT_ID" \
                  --job-id "$job_id" \
                  --region "$SOURCE_REGION" \
                  --query Job.Status \
                  --output text)
                echo "S3 Batch Replication job $job_id status: $status"

                case "$status" in
                  Complete)
                    aws s3control describe-job \
                      --account-id "$ACCOUNT_ID" \
                      --job-id "$job_id" \
                      --region "$SOURCE_REGION" \
                      --output json > /dev/termination-log
                    failed=$(aws s3control describe-job \
                      --account-id "$ACCOUNT_ID" \
                      --job-id "$job_id" \
                      --region "$SOURCE_REGION" \
                      --query Job.ProgressSummary.NumberOfTasksFailed \
                      --output text)
                    if [ "$failed" != "0" ]; then
                      echo "S3 Batch Replication completed with $failed failed tasks" >&2
                      exit 1
                    fi
                    exit 0
                    ;;
                  Cancelled|Failed)
                    aws s3control describe-job \
                      --account-id "$ACCOUNT_ID" \
                      --job-id "$job_id" \
                      --region "$SOURCE_REGION" \
                      --output json > /dev/termination-log
                    exit 1
                    ;;
                esac

                sleep "$POLL_INTERVAL_SECONDS"
              done
          env:
            - name: AWS_ROLE_ARN
              value: {{ $executorRoleArn }}
            - name: AWS_WEB_IDENTITY_TOKEN_FILE
              value: /var/run/secrets/aws-web-identity/token
            - name: AWS_REGION
              value: {{ $spec.sourceRegion }}
            - name: AWS_DEFAULT_REGION
              value: {{ $spec.sourceRegion }}
            - name: AWS_PAGER
              value: ""
            - name: ACCOUNT_ID
              value: {{ $spec.accountId | quote }}
            - name: SOURCE_BUCKET
              value: {{ $spec.sourceBucket }}
            - name: SOURCE_REGION
              value: {{ $spec.sourceRegion }}
            - name: DESTINATION_BUCKET
              value: {{ $spec.destinationBucket }}
            - name: DESTINATION_REGION
              value: {{ $spec.destinationRegion }}
            - name: MINIMUM_OBJECT_LOCK_RETENTION_DAYS
              value: {{ $spec.minimumObjectLockRetentionDays | quote }}
            - name: REPLICATION_RULE_ID
              value: {{ $spec.replicationRuleId | quote }}
            - name: REPORT_BUCKET
              value: {{ $spec.reportBucket }}
            - name: REPORT_PREFIX
              value: {{ $spec.reportPrefix | quote }}
            - name: PRIORITY
              value: {{ $spec.priority | quote }}
            - name: BATCH_ROLE_ARN
              value: {{ $batchRoleArn }}
            - name: CLIENT_REQUEST_TOKEN
              value: {{ $clientRequestToken }}
            - name: POLL_INTERVAL_SECONDS
              value: {{ $spec.pollIntervalSeconds | quote }}
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: aws-web-identity-token
              mountPath: /var/run/secrets/aws-web-identity
              readOnly: true
      volumes:
        - name: aws-web-identity-token
          projected:
            defaultMode: 420
            sources:
              - serviceAccountToken:
                  audience: sts.amazonaws.com
                  expirationSeconds: 3600
                  path: token
{{- end }}
---
apiVersion: nebula.io/v1alpha1
kind: XS3BatchReplication
metadata:
  name: {{ $xrName }}
status:
  {{- if get $ready "jobComplete" }}
  phase: Succeeded
  {{- else if get $ready "jobFailed" }}
  phase: Failed
  {{- else if $observedJob }}
  phase: Running
  {{- else if get $ready "iam" }}
  phase: Pending
  {{- else }}
  phase: WaitingForInfrastructure
  {{- end }}
  jobName: {{ $jobName }}
  reportUri: {{ printf "s3://%s/%s" $spec.reportBucket $spec.reportPrefix | quote }}
`.trim();
  }
}

/**
 * Creates one immutable S3 Batch Replication XR. The XR, its completed Job, and
 * its status are intentionally retained in Git as the audit record for the run.
 */
export class S3BatchReplication extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: S3BatchReplicationConfig) {
    super(scope, id);

    this.validateConfig(config);

    const namespace = config.namespace ?? "crossplane-system";
    const reportPrefix =
      config.reportPrefix ??
      `nebula/s3-batch-replication/${config.name}/${config.runId}`;

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XS3BatchReplication",
      metadata: {
        name: config.name,
        annotations: {
          [ARGOCD_SYNC_WAVE_ANNOTATION]: config.syncWave ?? "5",
        },
      },
      spec: {
        accountId: config.accountId,
        sourceBucket: config.sourceBucket,
        sourceRegion: config.sourceRegion,
        destinationBucket: config.destinationBucket,
        destinationRegion: config.destinationRegion,
        minimumObjectLockRetentionDays:
          config.minimumObjectLockRetentionDays ?? 90,
        replicationRuleId: config.replicationRuleId,
        reportBucket: config.reportBucket,
        reportPrefix,
        runId: config.runId,
        oidcIssuerUrl: config.oidcIssuerUrl,
        namespace,
        providerConfigRef: config.providerConfigRef ?? "default",
        priority: config.priority ?? 10,
        pollIntervalSeconds: config.pollIntervalSeconds ?? 30,
        activeDeadlineSeconds: config.activeDeadlineSeconds ?? 604800,
        jobImage: config.jobImage ?? DEFAULT_AWS_CLI_IMAGE,
      },
    });
  }

  private validateConfig(config: S3BatchReplicationConfig): void {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(config.name)) {
      throw new Error(
        "S3BatchReplication name must be a lowercase DNS-compatible name",
      );
    }
    if (!/^[0-9]{12}$/.test(config.accountId)) {
      throw new Error("S3BatchReplication accountId must contain 12 digits");
    }
    const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/;
    if (!regionPattern.test(config.sourceRegion)) {
      throw new Error("S3BatchReplication sourceRegion is not a valid AWS region");
    }
    if (!regionPattern.test(config.destinationRegion)) {
      throw new Error(
        "S3BatchReplication destinationRegion is not a valid AWS region",
      );
    }
    if (
      config.minimumObjectLockRetentionDays !== undefined &&
      (!Number.isInteger(config.minimumObjectLockRetentionDays) ||
        config.minimumObjectLockRetentionDays < 1)
    ) {
      throw new Error(
        "S3BatchReplication minimumObjectLockRetentionDays must be a positive integer",
      );
    }
    if (!/^https:\/\/[^/]+(?:\/[^/]+)*$/.test(config.oidcIssuerUrl)) {
      throw new Error(
        "S3BatchReplication oidcIssuerUrl must be an HTTPS issuer URL without a trailing slash",
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.runId)) {
      throw new Error(
        "S3BatchReplication runId may contain only letters, digits, dots, underscores, and hyphens",
      );
    }
  }
}
