import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as gcp from '@pulumi/gcp';
import type { Environment } from '../../core/environment';
import type { Infra } from '../infra';
import type { K8s } from './index';

export interface WorkloadIdentitySpec {
  ksaName: string;
  namespace: string;
  gsaEmail?: pulumi.Input<string>;
  gsaName?: string;
  roles?: string[];
}

export interface HelmAddonSpec {
  name: string;
  namespace?: string;
  repo?: { name: string; url: string };
  chart: string;
  version?: string;
  values?: pulumi.Input<any>;
  wi?: WorkloadIdentitySpec;
  deploy?: boolean;
}

export abstract class K8sAddon {
  public readonly deploy?: boolean;
  protected readonly k8s: K8s;
  constructor(k8s: K8s, deploy?: boolean) { this.k8s = k8s; this.deploy = deploy; }
  public shouldDeploy(): boolean { return this.deploy !== false; }
  public get env(): Environment { return this.k8s.env; }
  public get infra(): Infra | undefined { return this.k8s.env.infra; }
  public get provider(): k8s.Provider { return this.k8s.provider!; }
  public get projectId(): pulumi.Input<string> | undefined { return gcp.config.project || (this.env as any)?.config?.gcpConfig?.projectId; }
  /** Implement this to create any needed cloud resources and Kubernetes objects. */
  public abstract apply(): void;
}

export function deployHelmAddon(args: {
  provider: k8s.Provider;
  spec: HelmAddonSpec;
  projectId?: pulumi.Input<string>;
}) {
  const { provider, spec, projectId } = args;
  const ns = spec.namespace || 'default';

  const namespace = new k8s.core.v1.Namespace(spec.name + '-ns', {
    metadata: { name: ns }
  }, { provider });

  let gsaEmail: pulumi.Output<string> | pulumi.Input<string> | undefined = spec.wi?.gsaEmail;
  if (spec.wi && !gsaEmail) {
    const gsa = new gcp.serviceaccount.Account(spec.wi.gsaName || `${spec.name}-gsa`, {
      accountId: (spec.wi.gsaName || `${spec.name}-gsa`).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      displayName: `${spec.name} addon GSA`,
    });
    gsaEmail = gsa.email;
    (spec.wi.roles || []).forEach((role, idx) => {
      new gcp.projects.IAMMember(`${spec.name}-gsa-role-${idx}`, {
        project: projectId || gcp.config.project!,
        role,
        member: pulumi.interpolate`serviceAccount:${gsa.email}`,
      });
    });
  }

  if (spec.wi && gsaEmail) {
    new k8s.core.v1.ServiceAccount(`${spec.name}-ksa`, {
      metadata: {
        name: spec.wi.ksaName,
        namespace: ns,
        annotations: {
          'iam.gke.io/gcp-service-account': pulumi.output(gsaEmail),
        },
      }
    }, { provider, dependsOn: [namespace] });
  }

  return new k8s.helm.v3.Chart(spec.name, {
    namespace: ns,
    chart: spec.chart,
    version: spec.version,
    fetchOpts: spec.repo ? { repo: spec.repo.url } : undefined,
    values: spec.values,
  }, { provider, dependsOn: [namespace] });
}

export class HelmChartAddon extends K8sAddon {
  public readonly spec: HelmAddonSpec;
  constructor(k8s: K8s, spec: HelmAddonSpec) {
    super(k8s, spec.deploy);
    this.spec = spec;
  }
  public apply(): void {
    deployHelmAddon({ provider: this.provider, spec: this.spec, projectId: this.projectId });
  }
}


