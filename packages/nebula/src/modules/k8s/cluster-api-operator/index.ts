/**
 * ClusterApiOperator - Kubernetes Cluster API Operator for managing cluster lifecycle.
 * 
 * @example
 * ```typescript
 * import { ClusterApiOperator } from 'nebula/modules/k8s/cluster-api-operator';
 * 
 * new ClusterApiOperator(chart, 'capi', {
 *   version: '0.24.1',
 * });
 * ```
 */
import { Construct } from 'constructs';
import { Helm } from 'cdk8s';
import * as kplus from 'cdk8s-plus-33';
import { deepmerge } from 'deepmerge-ts';
import { BaseConstruct } from '../../../core';

export interface ClusterApiOperatorConfig {
  /** Namespace for the operator (defaults to capi-operator-system) */
  namespace?: string;
  /** Helm chart version (defaults to 0.24.1) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Additional Helm values to merge with defaults */
  values?: Record<string, unknown>;
  /** Infrastructure providers configuration */
  infrastructure?: {
    gcp?: { version?: string };
    k0smotron?: { version?: string };
  };
  /** Core providers configuration */
  core?: {
    'cluster-api'?: { version?: string };
  };
  /** Control plane providers configuration */
  controlPlane?: {
    k0smotron?: { version?: string };
  };
  /** Bootstrap providers configuration */
  bootstrap?: {
    k0smotron?: { version?: string };
  };
}

export class ClusterApiOperator extends BaseConstruct<ClusterApiOperatorConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;

  constructor(scope: Construct, id: string, config: ClusterApiOperatorConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? 'capi-operator-system';

    // Create namespace
    this.namespace = new kplus.Namespace(this, 'namespace', {
      metadata: { name: namespaceName },
    });

    const defaultValues: Record<string, unknown> = {
      tolerations: [
        { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' },
      ],
      infrastructure: {
        gcp: {
          version: this.config.infrastructure?.gcp?.version ?? 'v1.10.0',
        },
        k0smotron: {
          version: this.config.infrastructure?.k0smotron?.version ?? 'v1.7.0',
        },
      },
      core: {
        'cluster-api': {
          version: this.config.core?.['cluster-api']?.version ?? 'v1.9.5',
        },
      },
      controlPlane: {
        k0smotron: {
          version: this.config.controlPlane?.k0smotron?.version ?? 'v1.7.0',
        },
      },
      bootstrap: {
        k0smotron: {
          version: this.config.bootstrap?.k0smotron?.version ?? 'v1.7.0',
        },
      },
      certManager: {
        enabled: false, // We use our own cert-manager
      },
    };

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, 'helm', {
      chart: 'cluster-api-operator',
      repo: this.config.repository ?? 'https://kubernetes-sigs.github.io/cluster-api-operator',
      version: this.config.version ?? '0.25.0',
      namespace: namespaceName,
      values: chartValues,
    });
  }
}
