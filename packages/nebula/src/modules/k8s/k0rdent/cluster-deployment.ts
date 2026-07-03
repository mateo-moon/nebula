/**
 * ClusterDeployment — instantiates a k0rdent `ClusterTemplate` into a child
 * cluster. `template` names the ClusterTemplate (a bundled one like
 * `aws-standalone-cp-1-0-34`, or a nebula-generated custom template — Phase 2),
 * `credential` names a {@link Credential}, and `config` is the value object the
 * template's Helm chart expects. `serviceSpec` optionally delivers add-ons into
 * the child via Sveltos (e.g. the Calico CNI — Phase 2).
 */
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import {
  ClusterDeployment as ClusterDeploymentCr,
  ClusterDeploymentSpecServiceSpec,
} from "#imports/k0rdent.mirantis.com";

export interface ClusterDeploymentConfig {
  /** ClusterDeployment name (also the child cluster name). */
  name: string;
  /** Namespace (default "kcm-system"). */
  namespace?: string;
  /** ClusterTemplate name to instantiate. */
  template: string;
  /** Credential name (see {@link Credential}). */
  credential: string;
  /** Value object matching the ClusterTemplate's chart schema. */
  config?: Record<string, unknown>;
  /** Sveltos service delivery into the child cluster (e.g. Calico CNI). */
  serviceSpec?: ClusterDeploymentSpecServiceSpec;
  /** Render-only (no provisioning) — useful to preview the CAPI object set. */
  dryRun?: boolean;
  /**
   * Propagate the Credential into the child cluster as a Sveltos resource
   * template (AWS cloud-controller / CSI credentials). Default left to k0rdent.
   */
  propagateCredentials?: boolean;
}

export class ClusterDeployment extends BaseConstruct<ClusterDeploymentConfig> {
  public readonly cr: ClusterDeploymentCr;

  constructor(scope: Construct, id: string, config: ClusterDeploymentConfig) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kcm-system";

    this.cr = new ClusterDeploymentCr(this, "cluster-deployment", {
      metadata: { name: this.config.name, namespace },
      spec: {
        template: this.config.template,
        credential: this.config.credential,
        ...(this.config.config !== undefined ? { config: this.config.config } : {}),
        ...(this.config.serviceSpec ? { serviceSpec: this.config.serviceSpec } : {}),
        ...(this.config.dryRun !== undefined ? { dryRun: this.config.dryRun } : {}),
        ...(this.config.propagateCredentials !== undefined
          ? { propagateCredentials: this.config.propagateCredentials }
          : {}),
      },
    });
  }
}
