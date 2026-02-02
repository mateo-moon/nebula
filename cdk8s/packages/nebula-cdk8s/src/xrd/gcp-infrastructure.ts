import { Chart, ChartProps } from 'cdk8s';
import { Construct } from 'constructs';
import { CompositeResourceDefinition, Composition, CompositionSpecMode } from '../../imports';

/**
 * Creates the XGcpInfrastructure CompositeResourceDefinition and its Composition.
 * 
 * This defines a high-level API for creating GCP infrastructure:
 * - VPC Network with subnets
 * - GKE Cluster
 * - Node Pools
 * - Service Accounts
 * 
 * Users create a GcpInfrastructure claim, Crossplane reconciles it to managed resources.
 * 
 * @example
 * ```yaml
 * apiVersion: nebula.io/v1alpha1
 * kind: GcpInfrastructure
 * metadata:
 *   name: dev
 * spec:
 *   project: my-project
 *   region: europe-west3
 *   gke:
 *     name: dev-gke
 *     location: europe-west3-a
 *   nodePools:
 *     - name: system
 *       machineType: n2d-standard-2
 *       minNodes: 2
 *       maxNodes: 4
 * ```
 */
export class GcpInfrastructureXrd extends Chart {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, props?: ChartProps) {
    super(scope, id, props);

    // ==================== XRD ====================
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
      metadata: {
        name: 'xgcpinfrastructures.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XGcpInfrastructure',
          plural: 'xgcpinfrastructures',
        },
        claimNames: {
          kind: 'GcpInfrastructure',
          plural: 'gcpinfrastructures',
        },
        connectionSecretKeys: [
          'kubeconfig',
          'clusterEndpoint',
          'clusterCaCertificate',
        ],
        defaultCompositionRef: {
          name: 'gcp-infrastructure-v1',
        },
        versions: [
          {
            name: 'v1alpha1',
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: 'object',
                properties: {
                  spec: {
                    type: 'object',
                    required: ['project', 'region', 'gke', 'nodePools'],
                    properties: {
                      // Composition version selection
                      compositionRef: {
                        type: 'object',
                        description: 'Reference to a specific composition version',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Composition name (e.g., gcp-infrastructure-v1, gcp-infrastructure-v2)',
                          },
                        },
                      },
                      // GCP Project
                      project: {
                        type: 'string',
                        description: 'GCP project ID',
                      },
                      // Region
                      region: {
                        type: 'string',
                        description: 'GCP region (e.g., europe-west3)',
                      },
                      // Network configuration
                      network: {
                        type: 'object',
                        description: 'VPC network configuration',
                        properties: {
                          cidr: {
                            type: 'string',
                            default: '10.10.0.0/16',
                            description: 'Primary CIDR for the subnet',
                          },
                          podsCidr: {
                            type: 'string',
                            default: '10.20.0.0/16',
                            description: 'Secondary CIDR for pods',
                          },
                          servicesCidr: {
                            type: 'string',
                            default: '10.30.0.0/16',
                            description: 'Secondary CIDR for services',
                          },
                        },
                      },
                      // GKE configuration
                      gke: {
                        type: 'object',
                        required: ['name', 'location'],
                        description: 'GKE cluster configuration',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'Cluster name',
                          },
                          location: {
                            type: 'string',
                            description: 'Cluster location (zone or region)',
                          },
                          releaseChannel: {
                            type: 'string',
                            enum: ['RAPID', 'REGULAR', 'STABLE'],
                            default: 'REGULAR',
                            description: 'GKE release channel',
                          },
                          deletionProtection: {
                            type: 'boolean',
                            default: true,
                            description: 'Enable deletion protection',
                          },
                        },
                      },
                      // Node pools
                      nodePools: {
                        type: 'array',
                        description: 'Node pool configurations',
                        items: {
                          type: 'object',
                          required: ['name'],
                          properties: {
                            name: {
                              type: 'string',
                              description: 'Node pool name',
                            },
                            machineType: {
                              type: 'string',
                              default: 'e2-standard-4',
                              description: 'GCP machine type',
                            },
                            imageType: {
                              type: 'string',
                              description: 'Node image type (e.g., UBUNTU_CONTAINERD)',
                            },
                            minNodes: {
                              type: 'integer',
                              default: 1,
                              description: 'Minimum number of nodes',
                            },
                            maxNodes: {
                              type: 'integer',
                              default: 3,
                              description: 'Maximum number of nodes',
                            },
                            diskSizeGb: {
                              type: 'integer',
                              default: 100,
                              description: 'Disk size in GB',
                            },
                            spot: {
                              type: 'boolean',
                              default: false,
                              description: 'Use spot/preemptible VMs',
                            },
                            labels: {
                              type: 'object',
                              additionalProperties: { type: 'string' },
                              description: 'Node labels',
                            },
                            taints: {
                              type: 'array',
                              description: 'Node taints',
                              items: {
                                type: 'object',
                                required: ['key', 'effect'],
                                properties: {
                                  key: { type: 'string' },
                                  value: { type: 'string' },
                                  effect: {
                                    type: 'string',
                                    enum: ['NoSchedule', 'PreferNoSchedule', 'NoExecute'],
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  status: {
                    type: 'object',
                    properties: {
                      clusterEndpoint: {
                        type: 'string',
                        description: 'GKE cluster endpoint',
                      },
                      clusterCaCertificate: {
                        type: 'string',
                        description: 'GKE cluster CA certificate',
                      },
                      networkSelfLink: {
                        type: 'string',
                        description: 'VPC network self link',
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

    // ==================== COMPOSITION ====================
    this.composition = new Composition(this, 'composition', {
      metadata: {
        name: 'gcp-infrastructure-v1',
        labels: {
          'crossplane.io/xrd': 'xgcpinfrastructures.nebula.io',
          'nebula.io/version': 'v1',
          provider: 'gcp',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XGcpInfrastructure',
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: 'patch-and-transform',
            functionRef: {
              name: 'crossplane-contrib-function-patch-and-transform',
            },
            input: {
              apiVersion: 'pt.fn.crossplane.io/v1beta1',
              kind: 'Resources',
              resources: [
                // VPC Network
                {
                  name: 'network',
                  base: {
                    apiVersion: 'compute.gcp.upbound.io/v1beta1',
                    kind: 'Network',
                    spec: {
                      forProvider: {
                        autoCreateSubnetworks: false,
                        routingMode: 'REGIONAL',
                      },
                    },
                  },
                  patches: [
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.project' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'metadata.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-vpc' } }] },
                    { type: 'ToCompositeFieldPath', fromFieldPath: 'status.atProvider.selfLink', toFieldPath: 'status.networkSelfLink' },
                  ],
                },
                // Subnetwork
                {
                  name: 'subnetwork',
                  base: {
                    apiVersion: 'compute.gcp.upbound.io/v1beta1',
                    kind: 'Subnetwork',
                    spec: {
                      forProvider: {
                        privateIpGoogleAccess: true,
                      },
                    },
                  },
                  patches: [
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.project' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.region', toFieldPath: 'spec.forProvider.region' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'metadata.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-subnet' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'spec.forProvider.networkRef.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-vpc' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.network.cidr', toFieldPath: 'spec.forProvider.ipCidrRange' },
                    {
                      type: 'CombineFromComposite',
                      combine: {
                        variables: [
                          { fromFieldPath: 'metadata.name' },
                          { fromFieldPath: 'spec.network.podsCidr' },
                          { fromFieldPath: 'spec.network.servicesCidr' },
                        ],
                        strategy: 'string',
                        string: { fmt: '[{"rangeName":"%s-pods","ipCidrRange":"%s"},{"rangeName":"%s-services","ipCidrRange":"%s"}]' },
                      },
                      toFieldPath: 'spec.forProvider.secondaryIpRange',
                      transforms: [{ type: 'string', string: { type: 'Convert', convert: 'FromBase64' } }],
                    },
                  ],
                },
                // Service Account for nodes
                {
                  name: 'node-service-account',
                  base: {
                    apiVersion: 'cloudplatform.gcp.upbound.io/v1beta1',
                    kind: 'ServiceAccount',
                    spec: {
                      forProvider: {},
                    },
                  },
                  patches: [
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.project' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.name', toFieldPath: 'metadata.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-nodes' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.name', toFieldPath: 'spec.forProvider.displayName', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s GKE nodes' } }] },
                  ],
                },
                // IAM binding for node service account
                {
                  name: 'node-service-account-iam',
                  base: {
                    apiVersion: 'cloudplatform.gcp.upbound.io/v1beta1',
                    kind: 'ProjectIAMMember',
                    spec: {
                      forProvider: {
                        role: 'roles/container.defaultNodeServiceAccount',
                      },
                    },
                  },
                  patches: [
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.project' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.name', toFieldPath: 'metadata.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-nodes-iam' } }] },
                    {
                      type: 'CombineFromComposite',
                      combine: {
                        variables: [
                          { fromFieldPath: 'spec.gke.name' },
                          { fromFieldPath: 'spec.project' },
                        ],
                        strategy: 'string',
                        string: { fmt: 'serviceAccount:%s-nodes@%s.iam.gserviceaccount.com' },
                      },
                      toFieldPath: 'spec.forProvider.member',
                    },
                  ],
                },
                // GKE Cluster
                {
                  name: 'cluster',
                  base: {
                    apiVersion: 'container.gcp.upbound.io/v1beta2',
                    kind: 'Cluster',
                    spec: {
                      forProvider: {
                        removeDefaultNodePool: true,
                        initialNodeCount: 1,
                        networkingMode: 'VPC_NATIVE',
                        loggingService: 'logging.googleapis.com/kubernetes',
                        monitoringService: 'monitoring.googleapis.com/kubernetes',
                        enableShieldedNodes: true,
                        verticalPodAutoscaling: { enabled: true },
                        addonsConfig: {
                          httpLoadBalancing: { disabled: false },
                          horizontalPodAutoscaling: { disabled: false },
                        },
                      },
                    },
                  },
                  patches: [
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.project' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.name', toFieldPath: 'metadata.name' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.location', toFieldPath: 'spec.forProvider.location' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.deletionProtection', toFieldPath: 'spec.forProvider.deletionProtection' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'spec.forProvider.networkRef.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-vpc' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'spec.forProvider.subnetworkRef.name', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-subnet' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'spec.forProvider.ipAllocationPolicy.clusterSecondaryRangeName', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-pods' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'metadata.name', toFieldPath: 'spec.forProvider.ipAllocationPolicy.servicesSecondaryRangeName', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s-services' } }] },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.gke.releaseChannel', toFieldPath: 'spec.forProvider.releaseChannel.channel' },
                    { type: 'FromCompositeFieldPath', fromFieldPath: 'spec.project', toFieldPath: 'spec.forProvider.workloadIdentityConfig.workloadPool', transforms: [{ type: 'string', string: { type: 'Format', fmt: '%s.svc.id.goog' } }] },
                    { type: 'ToCompositeFieldPath', fromFieldPath: 'status.atProvider.endpoint', toFieldPath: 'status.clusterEndpoint' },
                    { type: 'ToCompositeFieldPath', fromFieldPath: 'status.atProvider.masterAuth[0].clusterCaCertificate', toFieldPath: 'status.clusterCaCertificate' },
                    {
                      type: 'ToCompositeFieldPath',
                      fromFieldPath: 'status.atProvider.endpoint',
                      toFieldPath: 'status.connectionDetails.clusterEndpoint',
                      policy: { fromFieldPath: 'Optional' },
                    },
                    {
                      type: 'ToCompositeFieldPath',
                      fromFieldPath: 'status.atProvider.masterAuth[0].clusterCaCertificate',
                      toFieldPath: 'status.connectionDetails.clusterCaCertificate',
                      policy: { fromFieldPath: 'Optional' },
                    },
                  ],
                  connectionDetails: [
                    { type: 'FromFieldPath', name: 'clusterEndpoint', fromFieldPath: 'status.atProvider.endpoint' },
                    { type: 'FromFieldPath', name: 'clusterCaCertificate', fromFieldPath: 'status.atProvider.masterAuth[0].clusterCaCertificate' },
                  ],
                },
              ],
            },
          },
          // Node pools via go-templating (for dynamic array handling)
          {
            step: 'node-pools',
            functionRef: {
              name: 'crossplane-contrib-function-go-templating',
            },
            input: {
              apiVersion: 'gotemplating.fn.crossplane.io/v1beta1',
              kind: 'GoTemplate',
              source: 'Inline',
              inline: {
                template: `
{{- $xr := .observed.composite.resource }}
{{- $spec := $xr.spec }}
{{- range $i, $pool := $spec.nodePools }}
---
apiVersion: container.gcp.upbound.io/v1beta2
kind: NodePool
metadata:
  name: {{ $spec.gke.name }}-{{ $pool.name }}
  annotations:
    crossplane.io/external-name: {{ $spec.gke.name }}-{{ $pool.name }}
spec:
  forProvider:
    project: {{ $spec.project }}
    location: {{ $spec.gke.location }}
    clusterRef:
      name: {{ $spec.gke.name }}
    {{- if gt (default 3 $pool.maxNodes) (default 1 $pool.minNodes) }}
    autoscaling:
      minNodeCount: {{ default 1 $pool.minNodes }}
      maxNodeCount: {{ default 3 $pool.maxNodes }}
    {{- else }}
    nodeCount: {{ default 1 $pool.minNodes }}
    {{- end }}
    nodeConfig:
      machineType: {{ default "e2-standard-4" $pool.machineType }}
      diskSizeGb: {{ default 100 $pool.diskSizeGb }}
      diskType: pd-standard
      {{- if $pool.imageType }}
      imageType: {{ $pool.imageType }}
      {{- end }}
      {{- if $pool.spot }}
      spot: true
      {{- end }}
      serviceAccountRef:
        name: {{ $spec.gke.name }}-nodes
      workloadMetadataConfig:
        mode: GKE_METADATA
      metadata:
        disable-legacy-endpoints: "true"
      {{- if $pool.labels }}
      labels:
        {{- range $k, $v := $pool.labels }}
        {{ $k }}: {{ $v | quote }}
        {{- end }}
      {{- end }}
      {{- if $pool.taints }}
      taint:
        {{- range $pool.taints }}
        - key: {{ .key }}
          value: {{ default "true" .value | quote }}
          effect: {{ .effect }}
        {{- end }}
      {{- end }}
    management:
      autoRepair: true
      autoUpgrade: true
{{- end }}
`,
              },
            },
          },
        ],
      },
    });
  }
}
