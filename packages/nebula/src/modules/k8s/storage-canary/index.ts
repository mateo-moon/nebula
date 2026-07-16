/**
 * Declarative, continuously-reconciled storage acceptance canary.
 *
 * `StorageCanarySetup` installs an XRD and Composition. A `StorageCanary` XR
 * then drives a complete EBS lifecycle without an operator-run script:
 *
 *   provision in three zones -> remount -> bounded online expansion ->
 *   quiesce -> snapshot -> cross-zone restore -> generic ephemeral PVC ->
 *   prove ephemeral cleanup -> delete the cycle -> wait -> repeat
 *
 * Crossplane owns every transient object. The Composition is a small state
 * machine implemented with function-go-templating; state is persisted only in
 * XR status. AWS EBS volumes created by CSI are observed (never adopted) with
 * provider-aws so the canary verifies their type, encryption, and zone.
 *
 * Prerequisites:
 * - Crossplane v2 with function-go-templating.
 * - provider-kubernetes with an InjectedIdentity ProviderConfig.
 * - provider-aws-ec2 with an AWS ProviderConfig.
 * - A CSI StorageClass and VolumeSnapshotClass.
 *
 * function-go-templating v0.9 returns a one-minute response TTL. Crossplane
 * uses that TTL to requeue realtime compositions (or its configured global
 * poll interval when realtime mode is off), so an idle canary wakes up and
 * starts a new cycle once `intervalSeconds` has elapsed.
 */
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import { syncWave } from "../../../core";

export const STORAGE_CANARY_API_GROUP = "nebula.io";
export const STORAGE_CANARY_API_VERSION = `${STORAGE_CANARY_API_GROUP}/v1alpha1`;
export const STORAGE_CANARY_KIND = "XStorageCanary";
export const STORAGE_CANARY_PLURAL = "xstoragecanaries";
export const STORAGE_CANARY_COMPOSITION = "storage-canary";
export const STORAGE_CANARY_NAMESPACE = "storage-canary";

export interface StorageCanarySetupConfig {
  /** Namespace where canary workloads run (default: storage-canary). */
  namespace?: string;
  /** Crossplane control-plane namespace (default: crossplane-system). */
  crossplaneNamespace?: string;
  /** Crossplane core ServiceAccount (default: crossplane). */
  crossplaneServiceAccountName?: string;
  /** provider-kubernetes ServiceAccount (default: provider-kubernetes). */
  kubernetesProviderServiceAccountName?: string;
  /** Installed function-go-templating Function name. */
  functionGoTemplatingName?: string;
  /** Composition name (default: storage-canary). */
  compositionName?: string;
}

export interface StorageCanaryConfig {
  /** AWS region containing all three availability zones. */
  region: string;
  /** Exactly three availability zones; source, restore, and expansion zones. */
  zones: readonly string[];
  /** CSI StorageClass to exercise (default: gp3). */
  storageClassName?: string;
  /** CSI VolumeSnapshotClass to exercise (default: ebs-csi). */
  volumeSnapshotClassName?: string;
  /** Namespace created by StorageCanarySetup (default: storage-canary). */
  namespace?: string;
  /** provider-kubernetes ProviderConfig used for read-only observers. */
  kubernetesProviderConfigName?: string;
  /** provider-aws ProviderConfig used for observe-only EBSVolume resources. */
  awsProviderConfigName?: string;
  /** Expected EBS volume type (default: gp3). */
  expectedVolumeType?: string;
  /** Initial PVC size (default: 1Gi). */
  volumeSize?: string;
  /** Autoresizer ceiling and expected expanded size (default: 2Gi). */
  expandedSize?: string;
  /** Data written to the expansion canary (default: 800 MiB). */
  fillMiB?: number;
  /** Delay between successful cycles (default: 21600 / 6h). */
  intervalSeconds?: number;
  /** Maximum time for one active phase (default: 1800 / 30m). */
  phaseTimeoutSeconds?: number;
  /** How long failed resources remain for inspection (default: 900 / 15m). */
  failureHoldSeconds?: number;
  /** Delay before retrying after a failed cycle (default: 1800 / 30m). */
  retryDelaySeconds?: number;
  /** Digest-pinned utility image used by direct argv probes. */
  probeImage?: string;
  /** Argo CD sync wave for the XR (default: 0). */
  syncWave?: number;
}

/** Installs the shared XRD, Composition, namespace, and least-privilege RBAC. */
export class StorageCanarySetup extends Construct {
  public readonly namespace: ApiObject;
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;

  constructor(
    scope: Construct,
    id: string,
    config: StorageCanarySetupConfig = {},
  ) {
    super(scope, id);

    const namespace = config.namespace ?? STORAGE_CANARY_NAMESPACE;
    const crossplaneNamespace =
      config.crossplaneNamespace ?? "crossplane-system";
    const crossplaneServiceAccount =
      config.crossplaneServiceAccountName ?? "crossplane";
    const kubernetesProviderServiceAccount =
      config.kubernetesProviderServiceAccountName ?? "provider-kubernetes";
    const compositionName =
      config.compositionName ?? STORAGE_CANARY_COMPOSITION;

    this.namespace = new ApiObject(this, "namespace", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        annotations: syncWave(-10),
        labels: {
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
      },
    });

    this.createRbac(
      namespace,
      crossplaneNamespace,
      crossplaneServiceAccount,
      kubernetesProviderServiceAccount,
    );

    this.xrd = this.createXrd(compositionName);
    this.composition = this.createComposition(
      compositionName,
      config.functionGoTemplatingName ?? "function-go-templating",
    );
  }

  private createRbac(
    namespace: string,
    crossplaneNamespace: string,
    crossplaneServiceAccount: string,
    kubernetesProviderServiceAccount: string,
  ): void {
    new ApiObject(this, "crossplane-workload-role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: "storage-canary-crossplane",
        namespace,
        annotations: syncWave(-9),
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["configmaps", "persistentvolumeclaims", "pods"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
        {
          apiGroups: ["apps"],
          resources: ["deployments"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
        {
          apiGroups: ["snapshot.storage.k8s.io"],
          resources: ["volumesnapshots"],
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
        },
      ],
    });

    new ApiObject(this, "crossplane-workload-role-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: {
        name: "storage-canary-crossplane",
        namespace,
        annotations: syncWave(-8),
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "storage-canary-crossplane",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: crossplaneServiceAccount,
          namespace: crossplaneNamespace,
        },
      ],
    });

    // The Kubernetes provider observes only the generated ephemeral PVC in the
    // canary namespace. It never creates, updates, or deletes that claim.
    new ApiObject(this, "kubernetes-provider-pvc-reader", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: "storage-canary-pvc-reader",
        namespace,
        annotations: syncWave(-9),
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["get", "list", "watch"],
        },
      ],
    });

    new ApiObject(this, "kubernetes-provider-pvc-reader-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: {
        name: "storage-canary-pvc-reader",
        namespace,
        annotations: syncWave(-8),
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "storage-canary-pvc-reader",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: kubernetesProviderServiceAccount,
          namespace: crossplaneNamespace,
        },
      ],
    });

    // PVs are cluster-scoped. This remains read-only and is bound only to the
    // provider-kubernetes identity used by the observer Objects.
    new ApiObject(this, "kubernetes-provider-pv-reader", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: {
        name: "storage-canary-pv-reader",
        annotations: syncWave(-9),
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["persistentvolumes"],
          verbs: ["get", "list", "watch"],
        },
      ],
    });

    new ApiObject(this, "kubernetes-provider-pv-reader-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: {
        name: "storage-canary-pv-reader",
        annotations: syncWave(-8),
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "storage-canary-pv-reader",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: kubernetesProviderServiceAccount,
          namespace: crossplaneNamespace,
        },
      ],
    });
  }

  private createXrd(
    compositionName: string,
  ): CompositeResourceDefinitionV2 {
    return new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: `${STORAGE_CANARY_PLURAL}.${STORAGE_CANARY_API_GROUP}`,
        annotations: syncWave(-10),
      },
      spec: {
        group: STORAGE_CANARY_API_GROUP,
        names: {
          kind: STORAGE_CANARY_KIND,
          plural: STORAGE_CANARY_PLURAL,
        },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        defaultCompositionRef: { name: compositionName },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            additionalPrinterColumns: [
              { name: "Phase", type: "string", jsonPath: ".status.phase" },
              {
                name: "Last Success",
                type: "date",
                jsonPath: ".status.lastSuccessfulTime",
              },
              {
                name: "Successes",
                type: "integer",
                jsonPath: ".status.successCount",
              },
              {
                name: "Failures",
                type: "integer",
                jsonPath: ".status.failureCount",
              },
            ],
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    required: [
                      "namespace",
                      "region",
                      "zones",
                      "storageClassName",
                      "volumeSnapshotClassName",
                      "kubernetesProviderConfigName",
                      "awsProviderConfigName",
                      "expectedVolumeType",
                      "volumeSize",
                      "expandedSize",
                      "fillMiB",
                      "intervalSeconds",
                      "phaseTimeoutSeconds",
                      "failureHoldSeconds",
                      "retryDelaySeconds",
                      "probeImage",
                    ],
                    properties: {
                      namespace: { type: "string" },
                      region: { type: "string" },
                      zones: {
                        type: "array",
                        minItems: 3,
                        maxItems: 3,
                        items: { type: "string" },
                      },
                      storageClassName: { type: "string" },
                      volumeSnapshotClassName: { type: "string" },
                      kubernetesProviderConfigName: { type: "string" },
                      awsProviderConfigName: { type: "string" },
                      expectedVolumeType: { type: "string" },
                      volumeSize: { type: "string" },
                      expandedSize: { type: "string" },
                      fillMiB: { type: "integer", minimum: 1 },
                      intervalSeconds: { type: "integer", minimum: 60 },
                      phaseTimeoutSeconds: { type: "integer", minimum: 60 },
                      failureHoldSeconds: { type: "integer", minimum: 0 },
                      retryDelaySeconds: { type: "integer", minimum: 60 },
                      probeImage: { type: "string" },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      phase: { type: "string" },
                      phaseStartedUnix: { type: "integer", format: "int64" },
                      startedUnix: { type: "integer", format: "int64" },
                      nextRunUnix: { type: "integer", format: "int64" },
                      successCount: { type: "integer", format: "int64" },
                      failureCount: { type: "integer", format: "int64" },
                      lastSuccessfulUnix: {
                        type: "integer",
                        format: "int64",
                      },
                      lastSuccessfulTime: { type: "string", format: "date-time" },
                      lastFailureUnix: { type: "integer", format: "int64" },
                      lastFailureTime: { type: "string", format: "date-time" },
                      lastFailurePhase: { type: "string" },
                      lastFailureReason: { type: "string" },
                      failedPhase: { type: "string" },
                      ephemeralPvcObserved: { type: "boolean" },
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
          "crossplane.io/xrd": `${STORAGE_CANARY_PLURAL}.${STORAGE_CANARY_API_GROUP}`,
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: STORAGE_CANARY_API_VERSION,
          kind: STORAGE_CANARY_KIND,
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "run-storage-canary",
            functionRef: { name: functionName },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: { template: STORAGE_CANARY_TEMPLATE },
            },
          },
        ],
      },
    });
  }
}

/** Creates one continuously-reconciled storage canary XR. */
export class StorageCanary extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: StorageCanaryConfig) {
    super(scope, id);

    if (config.zones.length !== 3) {
      throw new Error("StorageCanary requires exactly three availability zones");
    }

    for (const [field, value, minimum] of [
      ["fillMiB", config.fillMiB ?? 800, 1],
      ["intervalSeconds", config.intervalSeconds ?? 21_600, 60],
      ["phaseTimeoutSeconds", config.phaseTimeoutSeconds ?? 1_800, 60],
      ["failureHoldSeconds", config.failureHoldSeconds ?? 900, 0],
      ["retryDelaySeconds", config.retryDelaySeconds ?? 1_800, 60],
    ] as const) {
      if (!Number.isInteger(value) || value < minimum) {
        throw new Error(
          `StorageCanary ${field} must be an integer greater than or equal to ${minimum}`,
        );
      }
    }

    const namespace = config.namespace ?? STORAGE_CANARY_NAMESPACE;

    this.xr = new ApiObject(this, "xr", {
      apiVersion: STORAGE_CANARY_API_VERSION,
      kind: STORAGE_CANARY_KIND,
      metadata: {
        name: id,
        annotations: syncWave(config.syncWave ?? 0),
      },
      spec: {
        namespace,
        region: config.region,
        zones: [...config.zones],
        storageClassName: config.storageClassName ?? "gp3",
        volumeSnapshotClassName:
          config.volumeSnapshotClassName ?? "ebs-csi",
        kubernetesProviderConfigName:
          config.kubernetesProviderConfigName ?? "kubernetes-provider-config",
        awsProviderConfigName: config.awsProviderConfigName ?? "default",
        expectedVolumeType: config.expectedVolumeType ?? "gp3",
        volumeSize: config.volumeSize ?? "1Gi",
        expandedSize: config.expandedSize ?? "2Gi",
        fillMiB: config.fillMiB ?? 800,
        intervalSeconds: config.intervalSeconds ?? 21_600,
        phaseTimeoutSeconds: config.phaseTimeoutSeconds ?? 1_800,
        failureHoldSeconds: config.failureHoldSeconds ?? 900,
        retryDelaySeconds: config.retryDelaySeconds ?? 1_800,
        probeImage:
          config.probeImage ??
          "docker.io/library/busybox:1.37.0@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028",
      },
    });
  }
}

const STORAGE_CANARY_TEMPLATE = String.raw`
{{- $xr := .observed.composite.resource -}}
{{- $spec := $xr.spec -}}
{{- $status := default (dict) $xr.status -}}
{{- $resources := default (dict) .observed.resources -}}
{{- $phase := default "Idle" $status.phase -}}
{{- $now := now | unixEpoch -}}
{{- $started := default $now $status.startedUnix -}}
{{- $phaseStarted := default $now $status.phaseStartedUnix -}}
{{- $nextRun := default 0 $status.nextRunUnix -}}
{{- $successCount := default 0 $status.successCount -}}
{{- $failureCount := default 0 $status.failureCount -}}
{{- $lastSuccessUnix := default 0 $status.lastSuccessfulUnix -}}
{{- $lastSuccessTime := default "" $status.lastSuccessfulTime -}}
{{- $lastFailureUnix := default 0 $status.lastFailureUnix -}}
{{- $lastFailureTime := default "" $status.lastFailureTime -}}
{{- $lastFailurePhase := default "" $status.lastFailurePhase -}}
{{- $lastFailureReason := default "" $status.lastFailureReason -}}
{{- $failedPhase := default "" $status.failedPhase -}}
{{- $ephemeralObserved := default false $status.ephemeralPvcObserved -}}
{{- $nextPhase := $phase -}}
{{- $failureReason := "" -}}
{{- $renderPhase := $phase -}}
{{- if eq $phase "Failed" -}}
  {{- $renderPhase = default "Provision" $failedPhase -}}
{{- end -}}

{{/* Helpers are kept inline so this Composition works with the pinned v0.9 function. */}}
{{- $basePhases := list "Provision" "Restart" "Autosize" "Quiesce" "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup" -}}
{{- $keepBase := has $renderPhase $basePhases -}}
{{- $verifyPhases := list "Restart" "Autosize" "Quiesce" "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup" -}}
{{- $quiescePhases := list "Quiesce" "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup" -}}
{{- $snapshotPhases := list "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup" -}}
{{- $restorePhases := list "Restore" "Ephemeral" "EphemeralCleanup" -}}

{{- $allBaseReady := true -}}
{{- $baseMismatch := "" -}}
{{- range $i, $zone := $spec.zones -}}
  {{- $pvcKey := printf "data-pvc-%d" $i -}}
  {{- $deploymentKey := printf "data-deployment-%d" $i -}}
  {{- $pvObserverKey := printf "data-pv-observer-%d" $i -}}
  {{- $ebsObserverKey := printf "data-ebs-observer-%d" $i -}}
  {{- $pvc := index $resources $pvcKey -}}
  {{- $deployment := index $resources $deploymentKey -}}
  {{- $pvObserver := index $resources $pvObserverKey -}}
  {{- $ebsObserver := index $resources $ebsObserverKey -}}
  {{- $pvcBound := false -}}
  {{- $pvName := "" -}}
  {{- if and $pvc $pvc.resource -}}
    {{- $pvcBound = eq (default "" $pvc.resource.status.phase) "Bound" -}}
    {{- $pvName = default "" $pvc.resource.spec.volumeName -}}
  {{- end -}}
  {{- $mode := "write" -}}
  {{- if has $renderPhase $verifyPhases -}}{{- $mode = "verify" -}}{{- end -}}
  {{- $replicas := 1 -}}
  {{- if and (eq $i 0) (has $renderPhase $quiescePhases) -}}
    {{- $mode = "quiesced" -}}
    {{- $replicas = 0 -}}
  {{- end -}}
  {{- $deploymentReady := false -}}
  {{- if and $deployment $deployment.resource -}}
    {{- $observedMode := default "" (index (default (dict) $deployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") -}}
    {{- $generationCurrent := eq (default 0 $deployment.resource.status.observedGeneration | int64) (default -1 $deployment.resource.metadata.generation | int64) -}}
    {{- if eq $replicas 0 -}}
      {{- $deploymentReady = and (eq $observedMode $mode) $generationCurrent (eq (default 0 $deployment.resource.status.availableReplicas | int) 0) -}}
    {{- else -}}
      {{- $deploymentReady = and (eq $observedMode $mode) $generationCurrent (eq (default 0 $deployment.resource.status.availableReplicas | int) 1) (eq (default 0 $deployment.resource.status.updatedReplicas | int) 1) -}}
    {{- end -}}
  {{- end -}}
  {{- $volumeHandle := "" -}}
  {{- if and $pvObserver $pvObserver.resource $pvObserver.resource.status $pvObserver.resource.status.atProvider $pvObserver.resource.status.atProvider.manifest -}}
    {{- $volumeHandle = default "" $pvObserver.resource.status.atProvider.manifest.spec.csi.volumeHandle -}}
  {{- end -}}
  {{- $ebsReady := false -}}
  {{- if and $ebsObserver $ebsObserver.resource $ebsObserver.resource.status $ebsObserver.resource.status.atProvider -}}
    {{- $ebs := $ebsObserver.resource.status.atProvider -}}
    {{- if $ebs.id -}}
      {{- if or (ne (default "" $ebs.type) $spec.expectedVolumeType) (ne (default false $ebs.encrypted) true) (ne (default "" $ebs.availabilityZone) $zone) -}}
        {{- $baseMismatch = printf "volume %s is type=%s encrypted=%v zone=%s; expected %s/true/%s" (default "unknown" $ebs.id) (default "unknown" $ebs.type) (default false $ebs.encrypted) (default "unknown" $ebs.availabilityZone) $spec.expectedVolumeType $zone -}}
      {{- else -}}
        {{- $ebsReady = true -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if not (and $pvcBound $deploymentReady (ne $pvName "") (ne $volumeHandle "") $ebsReady) -}}
    {{- $allBaseReady = false -}}
  {{- end -}}
{{- end -}}

{{- $autoReady := false -}}
{{- $autoMismatch := "" -}}
{{- $autoPvc := index $resources "autoresize-pvc" -}}
{{- $autoDeployment := index $resources "autoresize-deployment" -}}
{{- $autoRequest := $spec.volumeSize -}}
{{- if and $autoPvc $autoPvc.resource -}}
  {{- $autoRequest = default $spec.volumeSize $autoPvc.resource.spec.resources.requests.storage -}}
  {{- if and (ne $autoRequest $spec.volumeSize) (ne $autoRequest $spec.expandedSize) -}}
    {{- $autoMismatch = printf "autoresizer requested %s; expected only %s or capped %s" $autoRequest $spec.volumeSize $spec.expandedSize -}}
  {{- end -}}
  {{- $autoCapacity := default "" $autoPvc.resource.status.capacity.storage -}}
  {{- $autoDeploymentReady := false -}}
  {{- if and $autoDeployment $autoDeployment.resource -}}
    {{- $autoMode := default "" (index (default (dict) $autoDeployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") -}}
    {{- $autoGenerationCurrent := eq (default 0 $autoDeployment.resource.status.observedGeneration | int64) (default -1 $autoDeployment.resource.metadata.generation | int64) -}}
    {{- $autoDeploymentReady = and (eq $autoMode "fill") $autoGenerationCurrent (eq (default 0 $autoDeployment.resource.status.availableReplicas | int) 1) -}}
  {{- end -}}
  {{- $autoReady = and (eq (default "" $autoPvc.resource.status.phase) "Bound") (eq $autoRequest $spec.expandedSize) (eq $autoCapacity $spec.expandedSize) $autoDeploymentReady -}}
{{- end -}}

{{- $snapshotReady := false -}}
{{- $snapshot := index $resources "snapshot" -}}
{{- if and $snapshot $snapshot.resource -}}
  {{- $snapshotReady = default false $snapshot.resource.status.readyToUse -}}
{{- end -}}

{{- $restoreReady := false -}}
{{- $restoreMismatch := "" -}}
{{- $restorePvc := index $resources "restore-pvc" -}}
{{- $restoreDeployment := index $resources "restore-deployment" -}}
{{- $restorePvObserver := index $resources "restore-pv-observer" -}}
{{- $restoreEbsObserver := index $resources "restore-ebs-observer" -}}
{{- $restorePvName := "" -}}
{{- if and $restorePvc $restorePvc.resource -}}
  {{- $restorePvName = default "" $restorePvc.resource.spec.volumeName -}}
{{- end -}}
{{- $restoreVolumeHandle := "" -}}
{{- if and $restorePvObserver $restorePvObserver.resource $restorePvObserver.resource.status $restorePvObserver.resource.status.atProvider $restorePvObserver.resource.status.atProvider.manifest -}}
  {{- $restoreVolumeHandle = default "" $restorePvObserver.resource.status.atProvider.manifest.spec.csi.volumeHandle -}}
{{- end -}}
{{- $restoreEbsReady := false -}}
{{- if and $restoreEbsObserver $restoreEbsObserver.resource $restoreEbsObserver.resource.status $restoreEbsObserver.resource.status.atProvider -}}
  {{- $ebs := $restoreEbsObserver.resource.status.atProvider -}}
  {{- if $ebs.id -}}
    {{- $restoreZone := index $spec.zones 1 -}}
    {{- if or (ne (default "" $ebs.type) $spec.expectedVolumeType) (ne (default false $ebs.encrypted) true) (ne (default "" $ebs.availabilityZone) $restoreZone) -}}
      {{- $restoreMismatch = printf "restored volume %s is type=%s encrypted=%v zone=%s; expected %s/true/%s" (default "unknown" $ebs.id) (default "unknown" $ebs.type) (default false $ebs.encrypted) (default "unknown" $ebs.availabilityZone) $spec.expectedVolumeType $restoreZone -}}
    {{- else -}}
      {{- $restoreEbsReady = true -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- $restoreDeploymentReady := false -}}
{{- if and $restoreDeployment $restoreDeployment.resource -}}
  {{- $restoreMode := default "" (index (default (dict) $restoreDeployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") -}}
  {{- $restoreGenerationCurrent := eq (default 0 $restoreDeployment.resource.status.observedGeneration | int64) (default -1 $restoreDeployment.resource.metadata.generation | int64) -}}
  {{- $restoreDeploymentReady = and (eq $restoreMode "restore") $restoreGenerationCurrent (eq (default 0 $restoreDeployment.resource.status.availableReplicas | int) 1) -}}
{{- end -}}
{{- if and $restorePvc $restorePvc.resource -}}
  {{- $restoreReady = and (eq (default "" $restorePvc.resource.status.phase) "Bound") $restoreDeploymentReady (ne $restorePvName "") (ne $restoreVolumeHandle "") $restoreEbsReady -}}
{{- end -}}

{{- $ephemeralPodSucceeded := false -}}
{{- $ephemeralPod := index $resources "ephemeral-pod" -}}
{{- if and $ephemeralPod $ephemeralPod.resource -}}
  {{- $ephemeralPodSucceeded = eq (default "" $ephemeralPod.resource.status.phase) "Succeeded" -}}
{{- end -}}
{{- $ephemeralObserver := index $resources "ephemeral-pvc-observer" -}}
{{- $ephemeralObserverReady := false -}}
{{- if and $ephemeralObserver $ephemeralObserver.resource $ephemeralObserver.resource.status -}}
  {{- range $condition := (default (list) $ephemeralObserver.resource.status.conditions) -}}
    {{- if and (eq (default "" $condition.type) "Ready") (eq (default "" $condition.status) "True") -}}
      {{- $ephemeralObserverReady = true -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- $ephemeralPresent := false -}}
{{- if and $ephemeralObserver $ephemeralObserver.resource $ephemeralObserver.resource.status $ephemeralObserver.resource.status.atProvider $ephemeralObserver.resource.status.atProvider.manifest -}}
  {{- $ephemeralPresent = and $ephemeralObserverReady (ne (default "" $ephemeralObserver.resource.status.atProvider.manifest.metadata.name) "") -}}
{{- end -}}

{{/* Decide the next state from observed state only. Desired resources below use the current state. */}}
{{- if eq $phase "Idle" -}}
  {{- if or (eq ($nextRun | int64) 0) (ge ($now | int64) ($nextRun | int64)) -}}
    {{- $nextPhase = "Provision" -}}
    {{- $ephemeralObserved = false -}}
  {{- end -}}
{{- else if eq $phase "Provision" -}}
  {{- if ne $baseMismatch "" -}}{{- $failureReason = $baseMismatch -}}
  {{- else if $allBaseReady -}}{{- $nextPhase = "Restart" -}}{{- end -}}
{{- else if eq $phase "Restart" -}}
  {{- if ne $baseMismatch "" -}}{{- $failureReason = $baseMismatch -}}
  {{- else if $allBaseReady -}}{{- $nextPhase = "Autosize" -}}{{- end -}}
{{- else if eq $phase "Autosize" -}}
  {{- if ne $autoMismatch "" -}}{{- $failureReason = $autoMismatch -}}
  {{- else if $autoReady -}}{{- $nextPhase = "Quiesce" -}}{{- end -}}
{{- else if eq $phase "Quiesce" -}}
  {{- if $allBaseReady -}}{{- $nextPhase = "Snapshot" -}}{{- end -}}
{{- else if eq $phase "Snapshot" -}}
  {{- if $snapshotReady -}}{{- $nextPhase = "Restore" -}}{{- end -}}
{{- else if eq $phase "Restore" -}}
  {{- if ne $restoreMismatch "" -}}{{- $failureReason = $restoreMismatch -}}
  {{- else if $restoreReady -}}{{- $nextPhase = "Ephemeral" -}}{{- end -}}
{{- else if eq $phase "Ephemeral" -}}
  {{- if and $ephemeralPodSucceeded $ephemeralPresent -}}
    {{- $ephemeralObserved = true -}}
    {{- $nextPhase = "EphemeralCleanup" -}}
  {{- end -}}
{{- else if eq $phase "EphemeralCleanup" -}}
  {{- if and $ephemeralObserved (not $ephemeralPresent) -}}
    {{- $successCount = add ($successCount | int64) 1 -}}
    {{- $lastSuccessUnix = $now -}}
    {{- $lastSuccessTime = now | date "2006-01-02T15:04:05Z07:00" -}}
    {{- $nextRun = add ($now | int64) ($spec.intervalSeconds | int64) -}}
    {{- $nextPhase = "Cleanup" -}}
  {{- end -}}
{{- else if eq $phase "Cleanup" -}}
  {{- if eq (len $resources) 0 -}}{{- $nextPhase = "Idle" -}}{{- end -}}
{{- else if eq $phase "Failed" -}}
  {{- if ge (sub ($now | int64) ($phaseStarted | int64)) ($spec.failureHoldSeconds | int64) -}}
    {{- $nextRun = add ($now | int64) ($spec.retryDelaySeconds | int64) -}}
    {{- $nextPhase = "Cleanup" -}}
  {{- end -}}
{{- end -}}

{{- $timedPhases := list "Provision" "Restart" "Autosize" "Quiesce" "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup" "Cleanup" -}}
{{- if and (eq $failureReason "") (has $phase $timedPhases) (ge (sub ($now | int64) ($phaseStarted | int64)) ($spec.phaseTimeoutSeconds | int64)) -}}
  {{- $failureReason = printf "phase %s exceeded %d seconds" $phase ($spec.phaseTimeoutSeconds | int64) -}}
{{- end -}}
{{- if ne $failureReason "" -}}
  {{- $failureCount = add ($failureCount | int64) 1 -}}
  {{- $lastFailureUnix = $now -}}
  {{- $lastFailureTime = now | date "2006-01-02T15:04:05Z07:00" -}}
  {{- $lastFailurePhase = $phase -}}
  {{- $lastFailureReason = $failureReason -}}
  {{- $failedPhase = $phase -}}
  {{- $nextPhase = "Failed" -}}
{{- end -}}
{{- if ne $nextPhase $phase -}}{{- $phaseStarted = $now -}}{{- end -}}

{{/* The three durable canary volumes and their remounting Deployments. */}}
{{- if $keepBase -}}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $xr.metadata.name }}-integrity-marker
  namespace: {{ $spec.namespace }}
  labels:
    app.kubernetes.io/name: storage-canary
    app.kubernetes.io/instance: {{ $xr.metadata.name }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: integrity-marker
    gotemplating.fn.crossplane.io/ready: "True"
data:
  marker: nebula-storage-canary-v1
{{- range $i, $zone := $spec.zones }}
{{- $pvcKey := printf "data-pvc-%d" $i }}
{{- $deploymentKey := printf "data-deployment-%d" $i }}
{{- $pvObserverKey := printf "data-pv-observer-%d" $i }}
{{- $ebsObserverKey := printf "data-ebs-observer-%d" $i }}
{{- $pvc := index $resources $pvcKey }}
{{- $deployment := index $resources $deploymentKey }}
{{- $pvObserver := index $resources $pvObserverKey }}
{{- $ebsObserver := index $resources $ebsObserverKey }}
{{- $pvcBound := false }}
{{- $pvName := "" }}
{{- if and $pvc $pvc.resource }}
  {{- $pvcBound = eq (default "" $pvc.resource.status.phase) "Bound" }}
  {{- $pvName = default "" $pvc.resource.spec.volumeName }}
{{- end }}
{{- $mode := "write" }}
{{- if has $renderPhase $verifyPhases }}{{- $mode = "verify" }}{{- end }}
{{- $replicas := 1 }}
{{- if and (eq $i 0) (has $renderPhase $quiescePhases) }}{{- $mode = "quiesced" }}{{- $replicas = 0 }}{{- end }}
{{- $deploymentReady := false }}
{{- if and $deployment $deployment.resource }}
  {{- $observedMode := default "" (index (default (dict) $deployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") }}
  {{- $generationCurrent := eq (default 0 $deployment.resource.status.observedGeneration | int64) (default -1 $deployment.resource.metadata.generation | int64) }}
  {{- if eq $replicas 0 }}
    {{- $deploymentReady = and (eq $observedMode $mode) $generationCurrent (eq (default 0 $deployment.resource.status.availableReplicas | int) 0) }}
  {{- else }}
    {{- $deploymentReady = and (eq $observedMode $mode) $generationCurrent (eq (default 0 $deployment.resource.status.availableReplicas | int) 1) (eq (default 0 $deployment.resource.status.updatedReplicas | int) 1) }}
  {{- end }}
{{- end }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $xr.metadata.name }}-data-{{ $i }}
  namespace: {{ $spec.namespace }}
  labels:
    app.kubernetes.io/name: storage-canary
    app.kubernetes.io/instance: {{ $xr.metadata.name }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $pvcKey }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $pvcBound | quote }}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: {{ $spec.storageClassName }}
  resources:
    requests:
      storage: {{ $spec.volumeSize }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $xr.metadata.name }}-data-{{ $i }}
  namespace: {{ $spec.namespace }}
  labels:
    app.kubernetes.io/name: storage-canary
    app.kubernetes.io/instance: {{ $xr.metadata.name }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $deploymentKey }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $deploymentReady | quote }}
    nebula.io/storage-canary-mode: {{ $mode }}
spec:
  replicas: {{ $replicas }}
  strategy:
    type: Recreate
  selector:
    matchLabels:
      nebula.io/storage-canary: {{ $xr.metadata.name }}-data-{{ $i }}
  template:
    metadata:
      labels:
        nebula.io/storage-canary: {{ $xr.metadata.name }}-data-{{ $i }}
    spec:
      nodeSelector:
        topology.ebs.csi.aws.com/zone: {{ $zone }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
{{- if eq $mode "write" }}
      initContainers:
        - name: writer
          image: {{ $spec.probeImage }}
          command: [dd]
          args: [if=/dev/zero, of=/data/payload, bs=1M, count=64, conv=fsync]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
        - name: marker-writer
          image: {{ $spec.probeImage }}
          command: [cp]
          args: [/expected/marker, /data/marker]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
            - name: expected
              mountPath: /expected
              readOnly: true
{{- end }}
      containers:
        - name: verifier
          image: {{ $spec.probeImage }}
          command: [sleep, "2147483647"]
          readinessProbe:
            exec:
              command: [cmp, /data/marker, /expected/marker]
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
            - name: expected
              mountPath: /expected
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ $xr.metadata.name }}-data-{{ $i }}
        - name: expected
          configMap:
            name: {{ $xr.metadata.name }}-integrity-marker
{{- if ne $pvName "" }}
{{- $volumeHandle := "" }}
{{- if and $pvObserver $pvObserver.resource $pvObserver.resource.status $pvObserver.resource.status.atProvider $pvObserver.resource.status.atProvider.manifest }}
  {{- $volumeHandle = default "" $pvObserver.resource.status.atProvider.manifest.spec.csi.volumeHandle }}
{{- end }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $pvObserverKey }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" (ne $volumeHandle "") | quote }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    manifest:
      apiVersion: v1
      kind: PersistentVolume
      metadata:
        name: {{ $pvName }}
  providerConfigRef:
    name: {{ $spec.kubernetesProviderConfigName }}
{{- if ne $volumeHandle "" }}
{{- $ebsReady := false }}
{{- if and $ebsObserver $ebsObserver.resource $ebsObserver.resource.status $ebsObserver.resource.status.atProvider }}
  {{- $ebs := $ebsObserver.resource.status.atProvider }}
  {{- $ebsReady = and (ne (default "" $ebs.id) "") (eq (default "" $ebs.type) $spec.expectedVolumeType) (eq (default false $ebs.encrypted) true) (eq (default "" $ebs.availabilityZone) $zone) }}
{{- end }}
---
apiVersion: ec2.aws.upbound.io/v1beta1
kind: EBSVolume
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ $ebsObserverKey }}
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $ebsReady | quote }}
    crossplane.io/external-name: {{ $volumeHandle }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    region: {{ $spec.region }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/* Online expansion. The desired request mirrors the observed request so the
     Composition accepts (and never reverts) the autoresizer's bounded update. */}}
{{- if has $renderPhase (list "Autosize" "Quiesce" "Snapshot" "Restore" "Ephemeral" "EphemeralCleanup") }}
{{- $autoPvc := index $resources "autoresize-pvc" }}
{{- $autoDeployment := index $resources "autoresize-deployment" }}
{{- $autoRequest := $spec.volumeSize }}
{{- $autoCapacity := "" }}
{{- if and $autoPvc $autoPvc.resource }}
  {{- $autoRequest = default $spec.volumeSize $autoPvc.resource.spec.resources.requests.storage }}
  {{- $autoCapacity = default "" $autoPvc.resource.status.capacity.storage }}
{{- end }}
{{- $autoDeploymentReady := false }}
{{- if and $autoDeployment $autoDeployment.resource }}
  {{- $autoMode := default "" (index (default (dict) $autoDeployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") }}
  {{- $autoGenerationCurrent := eq (default 0 $autoDeployment.resource.status.observedGeneration | int64) (default -1 $autoDeployment.resource.metadata.generation | int64) }}
  {{- $autoDeploymentReady = and (eq $autoMode "fill") $autoGenerationCurrent (eq (default 0 $autoDeployment.resource.status.availableReplicas | int) 1) }}
{{- end }}
{{- $autoPvcReady := and (eq $autoRequest $spec.expandedSize) (eq $autoCapacity $spec.expandedSize) }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $xr.metadata.name }}-autoresize
  namespace: {{ $spec.namespace }}
  labels:
    app.kubernetes.io/name: storage-canary
    app.kubernetes.io/instance: {{ $xr.metadata.name }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: autoresize-pvc
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $autoPvcReady | quote }}
    resize.topolvm.io/storage_limit: {{ $spec.expandedSize }}
    resize.topolvm.io/threshold: "30%"
    resize.topolvm.io/increase: "5Gi"
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: {{ $spec.storageClassName }}
  resources:
    requests:
      storage: {{ $autoRequest }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $xr.metadata.name }}-autoresize
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: autoresize-deployment
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $autoDeploymentReady | quote }}
    nebula.io/storage-canary-mode: fill
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      nebula.io/storage-canary: {{ $xr.metadata.name }}-autoresize
  template:
    metadata:
      labels:
        nebula.io/storage-canary: {{ $xr.metadata.name }}-autoresize
    spec:
      nodeSelector:
        topology.ebs.csi.aws.com/zone: {{ index $spec.zones 2 }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        - name: filler
          image: {{ $spec.probeImage }}
          command: [dd]
          args: [if=/dev/zero, of=/data/fill, bs=1M, count={{ $spec.fillMiB }}, conv=fsync]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
      containers:
        - name: holder
          image: {{ $spec.probeImage }}
          command: [sleep, "2147483647"]
          readinessProbe:
            exec:
              command: [test, -s, /data/fill]
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ $xr.metadata.name }}-autoresize
{{- end }}

{{- if has $renderPhase $snapshotPhases }}
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: {{ $xr.metadata.name }}-source
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: snapshot
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $snapshotReady | quote }}
spec:
  volumeSnapshotClassName: {{ $spec.volumeSnapshotClassName }}
  source:
    persistentVolumeClaimName: {{ $xr.metadata.name }}-data-0
{{- end }}

{{- if has $renderPhase $restorePhases }}
{{- $restorePvc := index $resources "restore-pvc" }}
{{- $restoreDeployment := index $resources "restore-deployment" }}
{{- $restorePvObserver := index $resources "restore-pv-observer" }}
{{- $restoreEbsObserver := index $resources "restore-ebs-observer" }}
{{- $restorePvName := "" }}
{{- if and $restorePvc $restorePvc.resource }}{{- $restorePvName = default "" $restorePvc.resource.spec.volumeName }}{{- end }}
{{- $restoreDeploymentReady := false }}
{{- if and $restoreDeployment $restoreDeployment.resource }}
  {{- $restoreMode := default "" (index (default (dict) $restoreDeployment.resource.metadata.annotations) "nebula.io/storage-canary-mode") }}
  {{- $restoreGenerationCurrent := eq (default 0 $restoreDeployment.resource.status.observedGeneration | int64) (default -1 $restoreDeployment.resource.metadata.generation | int64) }}
  {{- $restoreDeploymentReady = and (eq $restoreMode "restore") $restoreGenerationCurrent (eq (default 0 $restoreDeployment.resource.status.availableReplicas | int) 1) }}
{{- end }}
{{- $restorePvcReady := false }}
{{- if and $restorePvc $restorePvc.resource }}
  {{- $restorePvcReady = eq (default "" $restorePvc.resource.status.phase) "Bound" }}
{{- end }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $xr.metadata.name }}-restore
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: restore-pvc
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $restorePvcReady | quote }}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: {{ $spec.storageClassName }}
  dataSource:
    apiGroup: snapshot.storage.k8s.io
    kind: VolumeSnapshot
    name: {{ $xr.metadata.name }}-source
  resources:
    requests:
      storage: {{ $spec.volumeSize }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $xr.metadata.name }}-restore
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: restore-deployment
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $restoreDeploymentReady | quote }}
    nebula.io/storage-canary-mode: restore
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      nebula.io/storage-canary: {{ $xr.metadata.name }}-restore
  template:
    metadata:
      labels:
        nebula.io/storage-canary: {{ $xr.metadata.name }}-restore
    spec:
      nodeSelector:
        topology.ebs.csi.aws.com/zone: {{ index $spec.zones 1 }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: verifier
          image: {{ $spec.probeImage }}
          command: [sleep, "2147483647"]
          readinessProbe:
            exec:
              command: [cmp, /data/marker, /expected/marker]
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: data
              mountPath: /data
            - name: expected
              mountPath: /expected
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ $xr.metadata.name }}-restore
        - name: expected
          configMap:
            name: {{ $xr.metadata.name }}-integrity-marker
{{- if ne $restorePvName "" }}
{{- $restoreVolumeHandle := "" }}
{{- if and $restorePvObserver $restorePvObserver.resource $restorePvObserver.resource.status $restorePvObserver.resource.status.atProvider $restorePvObserver.resource.status.atProvider.manifest }}
  {{- $restoreVolumeHandle = default "" $restorePvObserver.resource.status.atProvider.manifest.spec.csi.volumeHandle }}
{{- end }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: restore-pv-observer
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" (ne $restoreVolumeHandle "") | quote }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    manifest:
      apiVersion: v1
      kind: PersistentVolume
      metadata:
        name: {{ $restorePvName }}
  providerConfigRef:
    name: {{ $spec.kubernetesProviderConfigName }}
{{- if ne $restoreVolumeHandle "" }}
{{- $restoreEbsReady := false }}
{{- if and $restoreEbsObserver $restoreEbsObserver.resource $restoreEbsObserver.resource.status $restoreEbsObserver.resource.status.atProvider }}
  {{- $ebs := $restoreEbsObserver.resource.status.atProvider }}
  {{- $restoreEbsReady = and (ne (default "" $ebs.id) "") (eq (default "" $ebs.type) $spec.expectedVolumeType) (eq (default false $ebs.encrypted) true) (eq (default "" $ebs.availabilityZone) (index $spec.zones 1)) }}
{{- end }}
---
apiVersion: ec2.aws.upbound.io/v1beta1
kind: EBSVolume
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: restore-ebs-observer
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $restoreEbsReady | quote }}
    crossplane.io/external-name: {{ $restoreVolumeHandle }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    region: {{ $spec.region }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigName }}
{{- end }}
{{- end }}
{{- end }}

{{- if has $renderPhase (list "Ephemeral" "EphemeralCleanup") }}
{{- $ephemeralObserverCompositionReady := false }}
{{- if eq $renderPhase "Ephemeral" }}{{- $ephemeralObserverCompositionReady = $ephemeralPresent }}{{- else }}{{- $ephemeralObserverCompositionReady = not $ephemeralPresent }}{{- end }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: ephemeral-pvc-observer
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $ephemeralObserverCompositionReady | quote }}
spec:
  managementPolicies: [Observe]
  deletionPolicy: Orphan
  forProvider:
    manifest:
      apiVersion: v1
      kind: PersistentVolumeClaim
      metadata:
        name: {{ $xr.metadata.name }}-ephemeral-scratch
        namespace: {{ $spec.namespace }}
  providerConfigRef:
    name: {{ $spec.kubernetesProviderConfigName }}
{{- end }}

{{- if eq $renderPhase "Ephemeral" }}
---
apiVersion: v1
kind: Pod
metadata:
  name: {{ $xr.metadata.name }}-ephemeral
  namespace: {{ $spec.namespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: ephemeral-pod
    gotemplating.fn.crossplane.io/ready: {{ ternary "True" "False" $ephemeralPodSucceeded | quote }}
spec:
  restartPolicy: Never
  nodeSelector:
    topology.ebs.csi.aws.com/zone: {{ index $spec.zones 2 }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile:
      type: RuntimeDefault
  initContainers:
    - name: writer
      image: {{ $spec.probeImage }}
      command: [cp]
      args: [/expected/marker, /scratch/marker]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      volumeMounts:
        - name: scratch
          mountPath: /scratch
        - name: expected
          mountPath: /expected
          readOnly: true
  containers:
    - name: verifier
      image: {{ $spec.probeImage }}
      command: [cmp, /scratch/marker, /expected/marker]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      volumeMounts:
        - name: scratch
          mountPath: /scratch
        - name: expected
          mountPath: /expected
          readOnly: true
  volumes:
    - name: scratch
      ephemeral:
        volumeClaimTemplate:
          spec:
            accessModes: [ReadWriteOnce]
            storageClassName: {{ $spec.storageClassName }}
            resources:
              requests:
                storage: {{ $spec.volumeSize }}
    - name: expected
      configMap:
        name: {{ $xr.metadata.name }}-integrity-marker
{{- end }}

{{- $latestResultSucceeded := and (gt ($lastSuccessUnix | int64) 0) (gt ($lastSuccessUnix | int64) ($lastFailureUnix | int64)) -}}
{{- $latestResultFailed := and (gt ($lastFailureUnix | int64) 0) (ge ($lastFailureUnix | int64) ($lastSuccessUnix | int64)) -}}
{{- $latestFailureMessage := default "The latest storage canary cycle failed" $lastFailureReason }}
---
apiVersion: {{ $xr.apiVersion }}
kind: {{ $xr.kind }}
status:
  phase: {{ $nextPhase | quote }}
  phaseStartedUnix: {{ $phaseStarted }}
  startedUnix: {{ $started }}
  nextRunUnix: {{ $nextRun }}
  successCount: {{ $successCount }}
  failureCount: {{ $failureCount }}
  lastSuccessfulUnix: {{ $lastSuccessUnix }}
{{- if ne $lastSuccessTime "" }}
  lastSuccessfulTime: {{ $lastSuccessTime | quote }}
{{- end }}
  lastFailureUnix: {{ $lastFailureUnix }}
{{- if ne $lastFailureTime "" }}
  lastFailureTime: {{ $lastFailureTime | quote }}
{{- end }}
  lastFailurePhase: {{ $lastFailurePhase | quote }}
  lastFailureReason: {{ $lastFailureReason | quote }}
  failedPhase: {{ $failedPhase | quote }}
  ephemeralPvcObserved: {{ $ephemeralObserved }}
---
apiVersion: meta.gotemplating.fn.crossplane.io/v1alpha1
kind: ClaimConditions
conditions:
  - type: StorageCanaryHealthy
    status: {{ if $latestResultSucceeded }}"True"{{ else if $latestResultFailed }}"False"{{ else }}"Unknown"{{ end }}
    reason: {{ if $latestResultSucceeded }}CycleSucceeded{{ else if $latestResultFailed }}CycleFailed{{ else }}NoCompletedCycle{{ end }}
    message: {{ if $latestResultSucceeded }}"The latest storage canary cycle succeeded"{{ else if $latestResultFailed }}{{ $latestFailureMessage | quote }}{{ else }}"No storage canary cycle has completed yet"{{ end }}
    target: Composite
`.trim();
