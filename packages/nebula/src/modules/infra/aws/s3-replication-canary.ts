/**
 * Declarative acceptance test for an existing S3 live-replication rule.
 *
 * The Composition deliberately does not trust Argo CD sync waves or another
 * controller's cached status. Observe-only provider-aws resources read the live
 * S3 replication and Object Lock configurations. Only after the exact rule and
 * minimum COMPLIANCE retention are verified does the Composition create a
 * revision-specific source object. It then observes the destination object
 * without permission to create it and requires the replica's SHA-256 checksum
 * and Object Lock fields.
 *
 * Instantiate `S3ReplicationCanarySetup` once per management cluster and one
 * `S3ReplicationCanary` for each replicated object store. Each XR is immutable;
 * create a new name and revision to exercise the live rule again.
 */
import * as crypto from "crypto";
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { syncWave } from "../../../core";

export const S3_REPLICATION_CANARY_API_GROUP = "nebula.io";
export const S3_REPLICATION_CANARY_API_VERSION =
  `${S3_REPLICATION_CANARY_API_GROUP}/v1alpha1`;
export const S3_REPLICATION_CANARY_KIND = "XS3ReplicationCanary";
export const S3_REPLICATION_CANARY_PLURAL = "xs3replicationcanaries";
export const S3_REPLICATION_CANARY_COMPOSITION = "s3-replication-canary";

export interface S3ReplicationCanarySetupConfig {
  /** Installed function-go-templating Function name. */
  functionGoTemplatingName?: string;
  /** Composition name (default: s3-replication-canary). */
  compositionName?: string;
}

export interface S3ReplicationCanaryConfig {
  /** Stable DNS-safe XR name. */
  name: string;
  /** Source bucket and region. */
  sourceBucketName: string;
  sourceRegion: string;
  /** Destination bucket and region. */
  destinationBucketName: string;
  destinationRegion: string;
  /** Exact enabled S3 replication rule to verify before writing the source. */
  replicationRuleId: string;
  /** Minimum acceptable COMPLIANCE default retention on the backup bucket. */
  minimumObjectLockDays: number;
  /** Git-controlled DNS-label revision for this immutable run. */
  revision: string;
  /** Canary payload. Defaults to a deterministic name/revision string. */
  content?: string;
  /** S3 object key prefix (default: _nebula/replication-canary). */
  keyPrefix?: string;
  /** provider-aws ProviderConfig name (default: default). */
  awsProviderConfigName?: string;
  /** Argo CD sync wave for the XR (default: 5). */
  syncWave?: number;
}

/** Installs the shared XRD and Composition. */
export class S3ReplicationCanarySetup extends Construct {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(
    scope: Construct,
    id: string,
    config: S3ReplicationCanarySetupConfig = {},
  ) {
    super(scope, id);

    const compositionName =
      config.compositionName ?? S3_REPLICATION_CANARY_COMPOSITION;

    this.xrd = this.createXrd(compositionName);
    this.composition = this.createComposition(
      compositionName,
      config.functionGoTemplatingName ?? "function-go-templating",
    );
  }

  private createXrd(
    compositionName: string,
  ): CompositeResourceDefinitionV2 {
    const bucketSchema = {
      type: "string",
      minLength: 3,
      maxLength: 63,
      pattern: "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$",
    };
    const regionSchema = {
      type: "string",
      pattern: "^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$",
    };

    return new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: `${S3_REPLICATION_CANARY_PLURAL}.${S3_REPLICATION_CANARY_API_GROUP}`,
        annotations: syncWave(-10),
      },
      spec: {
        group: S3_REPLICATION_CANARY_API_GROUP,
        names: {
          kind: S3_REPLICATION_CANARY_KIND,
          plural: S3_REPLICATION_CANARY_PLURAL,
        },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        defaultCompositionRef: { name: compositionName },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            additionalPrinterColumns: [
              { name: "Revision", type: "string", jsonPath: ".spec.revision" },
              { name: "Phase", type: "string", jsonPath: ".status.phase" },
              {
                name: "Retain Until",
                type: "date",
                jsonPath: ".status.objectLockRetainUntilDate",
              },
            ],
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    required: [
                      "sourceBucketName",
                      "sourceRegion",
                      "destinationBucketName",
                      "destinationRegion",
                      "replicationRuleId",
                      "minimumObjectLockDays",
                      "revision",
                      "key",
                      "content",
                      "expectedChecksumSha256",
                      "awsProviderConfigName",
                    ],
                    properties: {
                      sourceBucketName: bucketSchema,
                      sourceRegion: regionSchema,
                      destinationBucketName: bucketSchema,
                      destinationRegion: regionSchema,
                      replicationRuleId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 255,
                      },
                      minimumObjectLockDays: {
                        type: "integer",
                        format: "int32",
                        minimum: 1,
                      },
                      revision: {
                        type: "string",
                        minLength: 1,
                        maxLength: 32,
                        pattern:
                          "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$",
                      },
                      key: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1024,
                      },
                      content: {
                        type: "string",
                        minLength: 1,
                        maxLength: 4096,
                      },
                      expectedChecksumSha256: {
                        type: "string",
                        pattern: "^[A-Za-z0-9+/]{43}=$",
                      },
                      awsProviderConfigName: {
                        type: "string",
                        minLength: 1,
                        default: "default",
                      },
                    },
                    "x-kubernetes-validations": [
                      {
                        rule:
                          "self.sourceBucketName == oldSelf.sourceBucketName && self.sourceRegion == oldSelf.sourceRegion && self.destinationBucketName == oldSelf.destinationBucketName && self.destinationRegion == oldSelf.destinationRegion && self.replicationRuleId == oldSelf.replicationRuleId && self.minimumObjectLockDays == oldSelf.minimumObjectLockDays && self.revision == oldSelf.revision && self.key == oldSelf.key && self.content == oldSelf.content && self.expectedChecksumSha256 == oldSelf.expectedChecksumSha256 && self.awsProviderConfigName == oldSelf.awsProviderConfigName",
                        message:
                          "S3 replication canary inputs are immutable; create a new XR name and revision for a new run",
                      },
                      {
                        rule: "self.sourceBucketName != self.destinationBucketName",
                        message: "source and destination buckets must differ",
                      },
                      {
                        rule: "self.sourceRegion != self.destinationRegion",
                        message: "source and destination regions must differ",
                      },
                    ],
                  },
                  status: {
                    type: "object",
                    properties: {
                      phase: { type: "string" },
                      key: { type: "string" },
                      expectedChecksumSha256: { type: "string" },
                      observedChecksumSha256: { type: "string" },
                      objectLockMode: { type: "string" },
                      objectLockRetainUntilDate: {
                        type: "string",
                        format: "date-time",
                      },
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

  private createComposition(
    compositionName: string,
    functionName: string,
  ): Composition {
    return new Composition(this, "composition", {
      metadata: {
        name: compositionName,
        annotations: syncWave(-5),
        labels: {
          "crossplane.io/xrd":
            `${S3_REPLICATION_CANARY_PLURAL}.${S3_REPLICATION_CANARY_API_GROUP}`,
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: S3_REPLICATION_CANARY_API_VERSION,
          kind: S3_REPLICATION_CANARY_KIND,
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "run-s3-replication-canary",
            functionRef: { name: functionName },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: { template: S3_REPLICATION_CANARY_TEMPLATE },
            },
          },
        ],
      },
    });
  }
}

/** Creates one continuously reconciled S3 replication acceptance XR. */
export class S3ReplicationCanary extends Construct {
  public readonly xr: ApiObject;
  public readonly key: string;
  public readonly expectedChecksumSha256: string;

  constructor(scope: Construct, id: string, config: S3ReplicationCanaryConfig) {
    super(scope, id);

    this.validateConfig(config);

    const content =
      config.content ??
      `nebula replication canary ${config.name} ${config.revision}\n`;
    const prefix = (config.keyPrefix ?? "_nebula/replication-canary").replace(
      /\/+$/,
      "",
    );
    this.key = `${prefix}/${config.revision}`;
    this.expectedChecksumSha256 = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("base64");

    this.xr = new ApiObject(this, "xr", {
      apiVersion: S3_REPLICATION_CANARY_API_VERSION,
      kind: S3_REPLICATION_CANARY_KIND,
      metadata: {
        name: config.name,
        annotations: syncWave(config.syncWave ?? 5),
      },
      spec: {
        sourceBucketName: config.sourceBucketName,
        sourceRegion: config.sourceRegion,
        destinationBucketName: config.destinationBucketName,
        destinationRegion: config.destinationRegion,
        replicationRuleId: config.replicationRuleId,
        minimumObjectLockDays: config.minimumObjectLockDays,
        revision: config.revision,
        key: this.key,
        content,
        expectedChecksumSha256: this.expectedChecksumSha256,
        awsProviderConfigName: config.awsProviderConfigName ?? "default",
      },
    });
  }

  private validateConfig(config: S3ReplicationCanaryConfig): void {
    const dnsName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    const bucketName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
    const region = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/;
    const revision = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

    if (config.name.length > 63 || !dnsName.test(config.name)) {
      throw new Error(
        "S3ReplicationCanary name must be a lower-case DNS label of at most 63 characters",
      );
    }
    for (const [field, value] of [
      ["sourceBucketName", config.sourceBucketName],
      ["destinationBucketName", config.destinationBucketName],
    ] as const) {
      if (value.length < 3 || value.length > 63 || !bucketName.test(value)) {
        throw new Error(
          `${field} must be a valid 3-63 character S3 bucket name`,
        );
      }
    }
    if (config.sourceBucketName === config.destinationBucketName) {
      throw new Error("sourceBucketName and destinationBucketName must differ");
    }
    if (
      !region.test(config.sourceRegion) ||
      !region.test(config.destinationRegion)
    ) {
      throw new Error(
        "sourceRegion and destinationRegion must be valid AWS regions",
      );
    }
    if (config.sourceRegion === config.destinationRegion) {
      throw new Error("sourceRegion and destinationRegion must differ");
    }
    if (
      config.replicationRuleId.length < 1 ||
      config.replicationRuleId.length > 255
    ) {
      throw new Error(
        "replicationRuleId must contain between 1 and 255 characters",
      );
    }
    if (
      !Number.isInteger(config.minimumObjectLockDays) ||
      config.minimumObjectLockDays < 1
    ) {
      throw new Error("minimumObjectLockDays must be a positive integer");
    }
    if (!revision.test(config.revision)) {
      throw new Error(
        "revision must be a lower-case DNS label of at most 32 characters",
      );
    }
    if (config.content !== undefined && config.content.length === 0) {
      throw new Error("content must not be empty");
    }
    if (config.content !== undefined && config.content.length > 4096) {
      throw new Error("content must not exceed 4096 characters");
    }
    if (config.keyPrefix !== undefined) {
      const key = `${config.keyPrefix.replace(/\/+$/, "")}/${config.revision}`;
      if (key.length > 1024 || key.startsWith("/")) {
        throw new Error(
          "keyPrefix must produce a relative S3 key of at most 1024 characters",
        );
      }
    }
  }
}

const S3_REPLICATION_CANARY_TEMPLATE = String.raw`
{{- $xr := .observed.composite.resource -}}
{{- $spec := $xr.spec -}}
{{- $resources := default (dict) .observed.resources -}}
{{- $runHash := (printf "%s/%s/%s" $xr.metadata.name $spec.revision $spec.expectedChecksumSha256 | sha256sum | trunc 8) -}}
{{- $baseName := ($xr.metadata.name | trunc 30 | trimSuffix "-") -}}
{{- $revisionName := ($spec.revision | trunc 14 | trimSuffix "-") -}}
{{- $sourceName := printf "%s-%s-%s-source" $baseName $revisionName $runHash -}}
{{- $destinationName := printf "%s-%s-%s-replica" $baseName $revisionName $runHash -}}
{{- $sourceResourceName := printf "canary-source-%s" $runHash -}}
{{- $destinationResourceName := printf "canary-destination-%s" $runHash -}}

{{- $replicationReady := false -}}
{{- $replicationObserver := index $resources "replication-configuration-observer" -}}
{{- $replicationConditionReady := false -}}
{{- $replicationConditionSynced := false -}}
{{- $replicationRuleReady := false -}}
{{- $replicationRole := "" -}}
{{- if and $replicationObserver $replicationObserver.resource $replicationObserver.resource.status -}}
  {{- range $condition := default (list) $replicationObserver.resource.status.conditions -}}
    {{- if and (eq (default "" $condition.type) "Ready") (eq (default "" $condition.status) "True") -}}
      {{- $replicationConditionReady = true -}}
    {{- end -}}
    {{- if and (eq (default "" $condition.type) "Synced") (eq (default "" $condition.status) "True") -}}
      {{- $replicationConditionSynced = true -}}
    {{- end -}}
  {{- end -}}
  {{- if $replicationObserver.resource.status.atProvider -}}
    {{- $atProvider := $replicationObserver.resource.status.atProvider -}}
    {{- $replicationRole = default "" $atProvider.role -}}
    {{- $expectedDestination := printf "arn:aws:s3:::%s" $spec.destinationBucketName -}}
    {{- range $rule := default (list) $atProvider.rule -}}
      {{- $destination := default (dict) $rule.destination -}}
      {{- $deleteMarker := default (dict) $rule.deleteMarkerReplication -}}
      {{- if and (eq (default "" $rule.id) $spec.replicationRuleId) (eq (default "" $rule.status) "Enabled") (eq (default "" $destination.bucket) $expectedDestination) (eq (default "" $deleteMarker.status) "Enabled") -}}
        {{- $replicationRuleReady = true -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- $replicationReady = and $replicationConditionReady $replicationConditionSynced $replicationRuleReady (ne $replicationRole "") -}}

{{- $objectLockReady := false -}}
{{- $objectLockObserver := index $resources "object-lock-configuration-observer" -}}
{{- $objectLockConditionReady := false -}}
{{- $objectLockConditionSynced := false -}}
{{- $objectLockEnabled := "" -}}
{{- $objectLockDefaultMode := "" -}}
{{- $objectLockDefaultDays := 0 -}}
{{- if and $objectLockObserver $objectLockObserver.resource $objectLockObserver.resource.status -}}
  {{- range $condition := default (list) $objectLockObserver.resource.status.conditions -}}
    {{- if and (eq (default "" $condition.type) "Ready") (eq (default "" $condition.status) "True") -}}
      {{- $objectLockConditionReady = true -}}
    {{- end -}}
    {{- if and (eq (default "" $condition.type) "Synced") (eq (default "" $condition.status) "True") -}}
      {{- $objectLockConditionSynced = true -}}
    {{- end -}}
  {{- end -}}
  {{- if $objectLockObserver.resource.status.atProvider -}}
    {{- $atProvider := $objectLockObserver.resource.status.atProvider -}}
    {{- $objectLockEnabled = default "" $atProvider.objectLockEnabled -}}
    {{- $objectLockRule := default (dict) $atProvider.rule -}}
    {{- $defaultRetention := default (dict) $objectLockRule.defaultRetention -}}
    {{- $objectLockDefaultMode = default "" $defaultRetention.mode -}}
    {{- $objectLockDefaultDays = default 0 $defaultRetention.days | int64 -}}
  {{- end -}}
{{- end -}}
{{- $objectLockReady = and $objectLockConditionReady $objectLockConditionSynced (eq $objectLockEnabled "Enabled") (eq $objectLockDefaultMode "COMPLIANCE") (ge ($objectLockDefaultDays | int64) ($spec.minimumObjectLockDays | int64)) -}}
{{- $infrastructureReady := and $replicationReady $objectLockReady -}}

{{- $sourceReady := false -}}
{{- $sourceChecksum := "" -}}
{{- $source := index $resources $sourceResourceName -}}
{{- if and $source $source.resource $source.resource.status $source.resource.status.atProvider -}}
  {{- $sourceChecksum = default "" $source.resource.status.atProvider.checksumSha256 -}}
  {{- range $condition := default (list) $source.resource.status.conditions -}}
    {{- if and (eq (default "" $condition.type) "Ready") (eq (default "" $condition.status) "True") (eq $sourceChecksum $spec.expectedChecksumSha256) -}}
      {{- $sourceReady = true -}}
    {{- end -}}
  {{- end -}}
{{- end -}}

{{- $destinationReady := false -}}
{{- $destinationChecksum := "" -}}
{{- $objectLockMode := "" -}}
{{- $retainUntil := "" -}}
{{- $destination := index $resources $destinationResourceName -}}
{{- if and $destination $destination.resource $destination.resource.status $destination.resource.status.atProvider -}}
  {{- $destinationChecksum = default "" $destination.resource.status.atProvider.checksumSha256 -}}
  {{- $objectLockMode = default "" $destination.resource.status.atProvider.objectLockMode -}}
  {{- $retainUntil = default "" $destination.resource.status.atProvider.objectLockRetainUntilDate -}}
  {{- range $condition := default (list) $destination.resource.status.conditions -}}
    {{- if and (eq (default "" $condition.type) "Ready") (eq (default "" $condition.status) "True") (eq $destinationChecksum $spec.expectedChecksumSha256) (eq $objectLockMode "COMPLIANCE") (ne $retainUntil "") -}}
      {{- $destinationReady = true -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
---
apiVersion: s3.aws.upbound.io/v1beta2
kind: BucketReplicationConfiguration
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: replication-configuration-observer
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $replicationReady | quote }}
    crossplane.io/external-name: {{ $spec.sourceBucketName }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    bucket: {{ $spec.sourceBucketName }}
    region: {{ $spec.sourceRegion }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
---
apiVersion: s3.aws.upbound.io/v1beta2
kind: BucketObjectLockConfiguration
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: object-lock-configuration-observer
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $objectLockReady | quote }}
    crossplane.io/external-name: {{ $spec.destinationBucketName }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    bucket: {{ $spec.destinationBucketName }}
    region: {{ $spec.destinationRegion }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
{{- if $infrastructureReady }}
---
apiVersion: s3.aws.upbound.io/v1beta2
kind: Object
metadata:
  name: {{ $sourceName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $sourceResourceName }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $sourceReady | quote }}
spec:
  deletionPolicy: Orphan
  forProvider:
    bucket: {{ $spec.sourceBucketName }}
    region: {{ $spec.sourceRegion }}
    key: {{ $spec.key | quote }}
    content: {{ $spec.content | quote }}
    checksumAlgorithm: SHA256
    forceDestroy: false
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
{{- end }}
{{- if and $infrastructureReady $sourceReady }}
---
apiVersion: s3.aws.upbound.io/v1beta2
kind: Object
metadata:
  name: {{ $destinationName }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $destinationResourceName }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $destinationReady | quote }}
    crossplane.io/external-name: {{ printf "%s/%s" $spec.destinationBucketName $spec.key | quote }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    bucket: {{ $spec.destinationBucketName }}
    region: {{ $spec.destinationRegion }}
    key: {{ $spec.key | quote }}
    checksumAlgorithm: SHA256
    objectLockMode: COMPLIANCE
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
{{- end }}
---
apiVersion: {{ $xr.apiVersion }}
kind: {{ $xr.kind }}
metadata:
  name: {{ $xr.metadata.name }}
status:
  {{- if $destinationReady }}
  phase: Succeeded
  {{- else if $sourceReady }}
  phase: WaitingForReplica
  {{- else if $infrastructureReady }}
  phase: CreatingSource
  {{- else if $replicationReady }}
  phase: WaitingForObjectLockConfiguration
  {{- else }}
  phase: WaitingForReplicationConfiguration
  {{- end }}
  key: {{ $spec.key | quote }}
  expectedChecksumSha256: {{ $spec.expectedChecksumSha256 | quote }}
  observedChecksumSha256: {{ $destinationChecksum | quote }}
  objectLockMode: {{ $objectLockMode | quote }}
  {{- if ne $retainUntil "" }}
  objectLockRetainUntilDate: {{ $retainUntil | quote }}
  {{- end }}
`.trim();
