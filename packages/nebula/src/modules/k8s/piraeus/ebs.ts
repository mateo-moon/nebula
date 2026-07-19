/**
 * Declarative LINSTOR EBS integration.
 *
 * LINSTOR currently accepts only a static AWS access key for an EBS remote.
 * This construct keeps that implementation detail out of Git: Crossplane uses
 * its workload-identity-authenticated AWS ProviderConfig to create a dedicated
 * IAM user and access key, publishes the generated secret as connection data,
 * and provider-http injects it directly into the LINSTOR API request.
 *
 * The Composition also reconciles one EBS remote and special target per AZ and
 * one EBS_INIT pool per Linux Kubernetes node. No imperative bootstrap script
 * or operator-maintained credential is required.
 */
import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct, syncWave } from "../../../core";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import {
  ProviderConfig as HttpProviderConfig,
  ProviderConfigSpecCredentialsSource as HttpCredentialsSource,
} from "#imports/http.crossplane.io";

export interface PiraeusEbsConfig {
  /** AWS region containing the Kubernetes nodes and EBS volumes */
  region: string;
  /** Availability zones in which LINSTOR may provision replicated EBS volumes */
  availabilityZones: readonly string[];
  /** Name of the XR instance (defaults to "piraeus-ebs") */
  name?: string;
  /** Workload-identity-authenticated Crossplane AWS ProviderConfig */
  awsProviderConfigRef?: string;
  /** provider-http ProviderConfig name (defaults to "linstor-http") */
  httpProviderConfigRef?: string;
  /** provider-kubernetes ProviderConfig used to reconcile AWS node topology labels */
  kubernetesProviderConfigRef?: string;
  /** Dedicated AWS IAM user name (defaults to "linstor-ebs") */
  iamUserName?: string;
  /** Intermediate AccessKey connection Secret name */
  credentialSecretName?: string;
  /** Intermediate AccessKey connection Secret namespace */
  credentialSecretNamespace?: string;
  /** LINSTOR master-passphrase Secret name */
  passphraseSecretName?: string;
  /** LINSTOR master-passphrase Secret namespace */
  passphraseSecretNamespace?: string;
  /** LINSTOR controller REST base URL */
  linstorUrl?: string;
  /** Namespace of the Crossplane core ServiceAccount */
  crossplaneNamespace?: string;
  /** Crossplane core ServiceAccount used to fetch ExtraResources */
  crossplaneServiceAccountName?: string;
  /** Namespace of the provider-kubernetes ServiceAccount */
  kubernetesProviderNamespace?: string;
  /** provider-kubernetes ServiceAccount used to reconcile Node labels */
  kubernetesProviderServiceAccountName?: string;
}

/**
 * Installs and instantiates the cluster-scoped XPiraeusEbsConfig API.
 *
 * Prerequisites:
 * - Crossplane v2 with function-go-templating
 * - provider-upjet-aws EC2 and IAM families
 * - provider-http v1.0.14+
 * - Piraeus Operator / LINSTOR 1.30+
 */
export class PiraeusEbs extends BaseConstruct<PiraeusEbsConfig> {
  public readonly httpProviderConfig: HttpProviderConfig;
  public readonly nodeReaderRole: ApiObject;
  public readonly nodeReaderBinding: ApiObject;
  public readonly nodeTopologyWriterRole: ApiObject;
  public readonly nodeTopologyWriterBinding: ApiObject;
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly instance: ApiObject;

  constructor(scope: Construct, id: string, config: PiraeusEbsConfig) {
    super(scope, id, config);

    if (this.config.availabilityZones.length === 0) {
      throw new Error("PiraeusEbs: availabilityZones must not be empty");
    }
    for (const zone of this.config.availabilityZones) {
      if (!zone.startsWith(this.config.region)) {
        throw new Error(
          `PiraeusEbs: availability zone "${zone}" is not in region "${this.config.region}"`,
        );
      }
    }

    const name = this.config.name ?? "piraeus-ebs";
    const httpProviderConfigRef =
      this.config.httpProviderConfigRef ?? "linstor-http";
    const credentialSecretName =
      this.config.credentialSecretName ?? "linstor-ebs-aws-credentials";
    const credentialSecretNamespace =
      this.config.credentialSecretNamespace ?? "crossplane-system";
    const passphraseSecretName =
      this.config.passphraseSecretName ?? "linstor-passphrase";
    const passphraseSecretNamespace =
      this.config.passphraseSecretNamespace ?? "piraeus-datastore";
    const crossplaneNamespace =
      this.config.crossplaneNamespace ?? "crossplane-system";
    const crossplaneServiceAccountName =
      this.config.crossplaneServiceAccountName ?? "crossplane";
    const kubernetesProviderNamespace =
      this.config.kubernetesProviderNamespace ?? crossplaneNamespace;
    const kubernetesProviderServiceAccountName =
      this.config.kubernetesProviderServiceAccountName ?? "provider-kubernetes";

    // function-go-templating asks Crossplane core to fetch Linux Nodes as
    // ExtraResources. Crossplane deliberately has no blanket access to arbitrary
    // cluster objects, so grant only the read verbs this composition requires.
    this.nodeReaderRole = new ApiObject(this, "crossplane-node-reader", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "crossplane-piraeus-ebs-node-reader" },
      rules: [
        {
          apiGroups: [""],
          resources: ["nodes"],
          verbs: ["get", "list", "watch"],
        },
      ],
    });

    this.nodeReaderBinding = new ApiObject(
      this,
      "crossplane-node-reader-binding",
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        metadata: { name: "crossplane-piraeus-ebs-node-reader" },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: "crossplane-piraeus-ebs-node-reader",
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: crossplaneServiceAccountName,
            namespace: crossplaneNamespace,
          },
        ],
      },
    );

    // AWS topology is encoded in every CAPA Node's providerID even when the
    // providerless k0s kubelet does not add the standard region/zone labels.
    // The Composition reconciles only those two labels through
    // provider-kubernetes. Keep that provider's permission scoped to Nodes and
    // to the verbs needed to observe and patch an existing object.
    this.nodeTopologyWriterRole = new ApiObject(
      this,
      "provider-kubernetes-node-topology-writer",
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        metadata: { name: "piraeus-ebs-node-topology-writer" },
        rules: [
          {
            apiGroups: [""],
            resources: ["nodes"],
            verbs: ["get", "list", "watch", "update", "patch"],
          },
        ],
      },
    );

    this.nodeTopologyWriterBinding = new ApiObject(
      this,
      "provider-kubernetes-node-topology-writer-binding",
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        metadata: { name: "piraeus-ebs-node-topology-writer" },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: "piraeus-ebs-node-topology-writer",
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: kubernetesProviderServiceAccountName,
            namespace: kubernetesProviderNamespace,
          },
        ],
      },
    );

    this.httpProviderConfig = new HttpProviderConfig(
      this,
      "http-provider-config",
      {
        metadata: {
          name: httpProviderConfigRef,
          annotations: syncWave(-12),
        },
        spec: {
          credentials: { source: HttpCredentialsSource.NONE },
        },
      },
    );

    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xpiraeusebsconfigs.nebula.io",
        annotations: syncWave(-10),
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XPiraeusEbsConfig",
          plural: "xpiraeusebsconfigs",
        },
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
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
                    required: [
                      "region",
                      "availabilityZones",
                      "iamUserName",
                      "awsProviderConfigRef",
                      "httpProviderConfigRef",
                      "credentialSecretName",
                      "credentialSecretNamespace",
                      "passphraseSecretName",
                      "passphraseSecretNamespace",
                      "linstorUrl",
                    ],
                    properties: {
                      region: { type: "string", minLength: 1 },
                      availabilityZones: {
                        type: "array",
                        minItems: 1,
                        // Kubernetes structural schemas forbid
                        // `uniqueItems: true`; a set list provides the same
                        // uniqueness guarantee without quadratic validation.
                        "x-kubernetes-list-type": "set",
                        items: { type: "string", minLength: 1 },
                      },
                      iamUserName: { type: "string", minLength: 1 },
                      awsProviderConfigRef: { type: "string", minLength: 1 },
                      httpProviderConfigRef: { type: "string", minLength: 1 },
                      kubernetesProviderConfigRef: {
                        type: "string",
                        minLength: 1,
                      },
                      credentialSecretName: { type: "string", minLength: 1 },
                      credentialSecretNamespace: {
                        type: "string",
                        minLength: 1,
                      },
                      passphraseSecretName: { type: "string", minLength: 1 },
                      passphraseSecretNamespace: {
                        type: "string",
                        minLength: 1,
                      },
                      linstorUrl: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    this.composition = new Composition(this, "composition", {
      metadata: {
        name: "piraeus-ebs",
        annotations: syncWave(-5),
        labels: {
          "crossplane.io/xrd": "xpiraeusebsconfigs.nebula.io",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XPiraeusEbsConfig",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "render-piraeus-ebs",
            functionRef: { name: "function-go-templating" },
            input: {
              apiVersion: "gotemplating.fn.crossplane.io/v1beta1",
              kind: "GoTemplate",
              source: "Inline",
              inline: { template: PIRAEUS_EBS_TEMPLATE },
            },
          },
        ],
      },
    });

    this.instance = new ApiObject(this, "instance", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XPiraeusEbsConfig",
      metadata: {
        name,
        annotations: syncWave(0),
      },
      spec: {
        region: this.config.region,
        availabilityZones: this.config.availabilityZones,
        iamUserName: this.config.iamUserName ?? "linstor-ebs",
        awsProviderConfigRef:
          this.config.awsProviderConfigRef ?? "default",
        httpProviderConfigRef,
        ...(this.config.kubernetesProviderConfigRef
          ? {
              kubernetesProviderConfigRef:
                this.config.kubernetesProviderConfigRef,
            }
          : {}),
        credentialSecretName,
        credentialSecretNamespace,
        passphraseSecretName,
        passphraseSecretNamespace,
        linstorUrl:
          this.config.linstorUrl ??
          "http://linstor-controller.piraeus-datastore.svc.cluster.local:3370",
      },
    });
  }
}

/**
 * One pipeline step deliberately owns the whole dependency graph. Crossplane
 * reruns the step while ExtraResources are being fetched and whenever a
 * composed resource changes, so newly joined Linux nodes receive EBS_INIT
 * pools without a bootstrap Job or shell script.
 */
const PIRAEUS_EBS_TEMPLATE = String.raw`
{{ $xr := .observed.composite.resource }}
{{ $spec := $xr.spec }}
{{ $kubernetesProviderConfigRef := default "kubernetes-provider-config" $spec.kubernetesProviderConfigRef }}
---
apiVersion: meta.gotemplating.fn.crossplane.io/v1alpha1
kind: ExtraResources
requirements:
  linux-nodes:
    apiVersion: v1
    kind: Node
    matchLabels:
      kubernetes.io/os: linux
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: User
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: iam-user
    crossplane.io/external-name: {{ $spec.iamUserName }}
  labels:
    nebula.io/piraeus-ebs-identity: {{ $xr.metadata.name }}
spec:
  forProvider:
    forceDestroy: true
    path: /piraeus/
    tags:
      ManagedBy: crossplane
      Purpose: piraeus-linstor-ebs
  providerConfigRef:
    name: {{ $spec.awsProviderConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: Policy
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: iam-policy
    crossplane.io/external-name: {{ printf "%s-policy" $spec.iamUserName }}
  labels:
    nebula.io/piraeus-ebs-policy: {{ $xr.metadata.name }}
spec:
  forProvider:
    description: LINSTOR EBS target and initiator operations
    path: /piraeus/
    policy: |
      {
        "Version": "2012-10-17",
        "Statement": [{
          "Sid": "LinstorEbs",
          "Effect": "Allow",
          "Action": [
            "ec2:AttachVolume",
            "ec2:CreateSnapshot",
            "ec2:CreateTags",
            "ec2:CreateVolume",
            "ec2:DeleteSnapshot",
            "ec2:DeleteTags",
            "ec2:DeleteVolume",
            "ec2:DescribeAvailabilityZones",
            "ec2:DescribeInstances",
            "ec2:DescribeSnapshots",
            "ec2:DescribeVolumes",
            "ec2:DescribeVolumesModifications",
            "ec2:DetachVolume",
            "ec2:ModifyVolume"
          ],
          "Resource": "*",
          "Condition": {
            "StringEquals": {"aws:RequestedRegion": "{{ $spec.region }}"}
          }
        }]
      }
    tags:
      ManagedBy: crossplane
      Purpose: piraeus-linstor-ebs
  providerConfigRef:
    name: {{ $spec.awsProviderConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: UserPolicyAttachment
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: iam-policy-attachment
spec:
  forProvider:
    policyArnSelector:
      matchControllerRef: true
      matchLabels:
        nebula.io/piraeus-ebs-policy: {{ $xr.metadata.name }}
    userSelector:
      matchControllerRef: true
      matchLabels:
        nebula.io/piraeus-ebs-identity: {{ $xr.metadata.name }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigRef }}
---
apiVersion: iam.aws.upbound.io/v1beta1
kind: AccessKey
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: access-key
spec:
  forProvider:
    status: Active
    userSelector:
      matchControllerRef: true
      matchLabels:
        nebula.io/piraeus-ebs-identity: {{ $xr.metadata.name }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigRef }}
  writeConnectionSecretToRef:
    name: {{ $spec.credentialSecretName }}
    namespace: {{ $spec.credentialSecretNamespace }}
---
apiVersion: ec2.aws.upbound.io/v1beta1
kind: EBSEncryptionByDefault
metadata:
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: ebs-encryption-by-default
spec:
  forProvider:
    enabled: true
    region: {{ $spec.region }}
  providerConfigRef:
    name: {{ $spec.awsProviderConfigRef }}

{{ $accessKeyId := "" }}
{{ $accessKeySecret := "" }}
{{ if .observed.resources }}
{{ with (index .observed.resources "access-key") }}
{{ with .resource }}
{{ with .status }}{{ with .atProvider }}{{ with .id }}
{{ $accessKeyId = . }}
{{ end }}{{ end }}{{ end }}
{{ end }}
{{ with .connectionDetails }}
{{ with (index . "attribute.secret") }}
{{ $accessKeySecret = . }}
{{ else }}{{ with (index . "secret") }}
{{ $accessKeySecret = . }}
{{ end }}{{ end }}
{{ end }}
{{ end }}
{{ end }}

{{ $passphraseData := "" }}
{{ if .observed.resources }}
{{ with (index .observed.resources "linstor-passphrase") }}
{{ with .resource }}{{ with .data }}{{ with (index . "MASTER_PASSPHRASE") }}
{{ $passphraseData = . }}
{{ end }}{{ end }}{{ end }}
{{ end }}
{{ end }}
{{ if and (eq $passphraseData "") (ne $accessKeySecret "") }}
{{ $passphraseData = (printf "%s:%s" $xr.metadata.uid ($accessKeySecret | b64dec) | sha256sum | b64enc) }}
{{ end }}
{{ if ne $passphraseData "" }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ $spec.passphraseSecretName }}
  namespace: {{ $spec.passphraseSecretNamespace }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: linstor-passphrase
type: Opaque
data:
  MASTER_PASSPHRASE: {{ $passphraseData }}
{{ end }}

{{ if and (ne $accessKeyId "") (ne $accessKeySecret "") (ne $passphraseData "") }}
{{ range $zone := $spec.availabilityZones }}
{{ $remoteName := printf "ebs-rem-%s" $zone }}
{{ $targetName := printf "ebs-target-%s" $zone }}
---
apiVersion: http.crossplane.io/v1alpha2
kind: Request
metadata:
  name: {{ printf "linstor-ebs-remote-%s" $zone }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ printf "remote-%s" $zone }}
spec:
  deletionPolicy: Delete
  forProvider:
    headers:
      Content-Type: [application/json]
    payload:
      baseUrl: {{ $spec.linstorUrl }}
      body: |
        {
          "remote_name": "{{ $remoteName }}",
          "endpoint": "https://ec2.{{ $spec.region }}.amazonaws.com",
          "region": "{{ $spec.region }}",
          "availability_zone": "{{ $zone }}",
          "access_key": "{{ $accessKeyId }}",
          "secret_key": "{{ printf "{{ %s:%s:attribute.secret }}" $spec.credentialSecretName $spec.credentialSecretNamespace }}"
        }
    mappings:
      - action: CREATE
        method: POST
        url: .payload.baseUrl + "/v1/remotes/ebs"
        body: .payload.body
      - action: OBSERVE
        method: GET
        url: .payload.baseUrl + "/v1/remotes/ebs"
      - action: UPDATE
        method: PUT
        url: .payload.baseUrl + "/v1/remotes/ebs/" + (.payload.body.remote_name | @uri)
        body: .payload.body
      - action: REMOVE
        method: DELETE
        url: .payload.baseUrl + "/v1/remotes?remote_name=" + (.payload.body.remote_name | @uri)
    expectedResponseCheck:
      type: CUSTOM
      logic: |
        (.response.body | if type == "string" then fromjson else . end) as $body |
        .payload.body as $desired |
        any($body[];
          .remote_name == $desired.remote_name and
          .endpoint == $desired.endpoint and
          .region == $desired.region and
          .availability_zone == $desired.availability_zone)
    isRemovedCheck:
      type: CUSTOM
      logic: |
        (.response.body | if type == "string" then fromjson else . end) as $body |
        .payload.body.remote_name as $name |
        ([$body[] | select(.remote_name == $name)] | length) == 0
  providerConfigRef:
    name: {{ $spec.httpProviderConfigRef }}
---
apiVersion: http.crossplane.io/v1alpha2
kind: Request
metadata:
  name: {{ printf "linstor-ebs-target-%s" $zone }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ printf "target-%s" $zone }}
spec:
  deletionPolicy: Delete
  forProvider:
    headers:
      Content-Type: [application/json]
    payload:
      baseUrl: {{ $spec.linstorUrl }}
      body: |
        {
          "name": "{{ $targetName }}",
          "ebs_remote_name": "{{ $remoteName }}",
          "region": "{{ $spec.region }}",
          "zone": "{{ $zone }}"
        }
    mappings:
      - action: CREATE
        method: POST
        url: .payload.baseUrl + "/v1/nodes/ebs"
        body: '{name: .payload.body.name, ebs_remote_name: .payload.body.ebs_remote_name}'
      - action: OBSERVE
        method: GET
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.name | @uri)
      - action: UPDATE
        method: PUT
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.name | @uri)
        body: |
          {override_props: {
            "Aux/topology/topology.kubernetes.io/region": .payload.body.region,
            "Aux/topology/topology.kubernetes.io/zone": .payload.body.zone
          }}
      - action: REMOVE
        method: DELETE
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.name | @uri)
    expectedResponseCheck:
      type: CUSTOM
      logic: |
        (.response.body | if type == "string" then fromjson else . end) as $body |
        $body.name == .payload.body.name and
        $body.connection_status == "ONLINE" and
        $body.props["Aux/topology/topology.kubernetes.io/region"] == .payload.body.region and
        $body.props["Aux/topology/topology.kubernetes.io/zone"] == .payload.body.zone
    isRemovedCheck:
      type: CUSTOM
      logic: .response.statusCode == 404
  providerConfigRef:
    name: {{ $spec.httpProviderConfigRef }}
{{ end }}

{{ if .extraResources }}
{{ with (index .extraResources "linux-nodes") }}
{{ range .items }}
{{ $node := .resource }}
{{ $nodeName := $node.metadata.name }}
{{ $zone := default "" (index $node.metadata.labels "topology.kubernetes.io/zone") }}
{{ $providerID := default "" $node.spec.providerID }}
{{ if and (eq $zone "") (hasPrefix "aws:///" $providerID) }}
{{ $providerParts := splitList "/" (trimPrefix "aws:///" $providerID) }}
{{ if gt (len $providerParts) 0 }}
{{ $zone = index $providerParts 0 }}
{{ end }}
{{ end }}
{{ if and $zone (has $zone $spec.availabilityZones) }}
{{ $remoteName := printf "ebs-rem-%s" $zone }}
{{ $nodeKey := printf "%s-%s" (trunc 36 $nodeName | trimSuffix "-") (sha256sum $nodeName | trunc 8) }}
---
apiVersion: kubernetes.crossplane.io/v1alpha2
kind: Object
metadata:
  name: {{ printf "piraeus-topology-%s" $nodeKey }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ printf "topology-%s" $nodeKey }}
spec:
  deletionPolicy: Orphan
  managementPolicies: [Observe, Update]
  providerConfigRef:
    name: {{ $kubernetesProviderConfigRef }}
  forProvider:
    manifest:
      apiVersion: v1
      kind: Node
      metadata:
        name: {{ $nodeName }}
        labels:
          topology.kubernetes.io/region: {{ $spec.region }}
          topology.kubernetes.io/zone: {{ $zone }}
---
apiVersion: http.crossplane.io/v1alpha2
kind: Request
metadata:
  name: {{ printf "linstor-ebs-init-%s" $nodeKey }}
  annotations:
    gotemplating.fn.crossplane.io/composition-resource-name: {{ printf "initiator-%s" $nodeKey }}
spec:
  deletionPolicy: Delete
  forProvider:
    headers:
      Content-Type: [application/json]
    payload:
      baseUrl: {{ $spec.linstorUrl }}
      body: |
        {
          "node": "{{ $nodeName }}",
          "pool": "EbsInitPool",
          "remote": "{{ $remoteName }}"
        }
    mappings:
      - action: CREATE
        method: POST
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.node | @uri) + "/storage-pools"
        body: |
          {
            storage_pool_name: .payload.body.pool,
            provider_kind: "EBS_INIT",
            props: {"StorDriver/EBS/Remote": .payload.body.remote}
          }
      - action: OBSERVE
        method: GET
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.node | @uri) + "/storage-pools/" + (.payload.body.pool | @uri)
      - action: UPDATE
        method: PUT
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.node | @uri) + "/storage-pools/" + (.payload.body.pool | @uri)
        body: '{override_props: {"StorDriver/EBS/Remote": .payload.body.remote}}'
      - action: REMOVE
        method: DELETE
        url: .payload.baseUrl + "/v1/nodes/" + (.payload.body.node | @uri) + "/storage-pools/" + (.payload.body.pool | @uri)
    expectedResponseCheck:
      type: CUSTOM
      logic: |
        (.response.body | if type == "string" then fromjson else . end) as $body |
        $body.storage_pool_name == .payload.body.pool and
        $body.provider_kind == "EBS_INIT" and
        $body.props["StorDriver/EBS/Remote"] == .payload.body.remote
    isRemovedCheck:
      type: CUSTOM
      logic: .response.statusCode == 404
  providerConfigRef:
    name: {{ $spec.httpProviderConfigRef }}
{{ end }}
{{ end }}
{{ end }}
{{ end }}
{{ end }}
`.trim();
