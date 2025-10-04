import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface ConstellationGcpIamConfig {
  vmServiceAccount?: {
    enabled?: boolean; // default true
    name?: string; // accountId
    roles?: string[]; // default logging + monitoring writers
    projectId?: string; // defaults to provider project
    displayName?: string;
  };
  clusterServiceAccount?: {
    enabled?: boolean; // default true
    name?: string; // accountId, default `${name}-cluster`
    projectId?: string; // defaults to provider project
    displayName?: string;
  };
}

export class ConstellationGcpIam extends pulumi.ComponentResource {
  public readonly vmServiceAccountEmail?: pulumi.Output<string>;
  public readonly serviceAccountKey?: pulumi.Output<string>;
  public readonly serviceAccountEmail?: pulumi.Output<string>;

  constructor(name: string, args?: ConstellationGcpIamConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:Iam', name, args, opts);

    const wantVmSa = args?.vmServiceAccount?.enabled !== false;
    if (wantVmSa) {
      const cfg = new pulumi.Config('gcp');
      const project = args?.vmServiceAccount?.projectId || cfg.require('project');
      const accountId = (args?.vmServiceAccount?.name || `${name}-vm`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      const displayName = args?.vmServiceAccount?.displayName || `${name} constellation VMs`;

      const sa = new gcp.serviceaccount.Account(`${name}-vm`, {
        accountId,
        displayName,
      }, { parent: this });

      const roles = (args?.vmServiceAccount?.roles && args.vmServiceAccount.roles.length > 0)
        ? args.vmServiceAccount.roles
        : [
            'roles/logging.logWriter',
            'roles/monitoring.metricWriter',
          ];
      roles.forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-vm-role-${idx}`, {
          project,
          role,
          member: pulumi.interpolate`serviceAccount:${sa.email}`,
        }, { parent: this });
      });

      this.vmServiceAccountEmail = sa.email;
    }

    // Create cluster SA and a JSON key for constellation provider input
    const wantClusterSa = args?.clusterServiceAccount?.enabled !== false;
    if (wantClusterSa) {
      const cfg = new pulumi.Config('gcp');
      const project = args?.clusterServiceAccount?.projectId || cfg.require('project');
      const accountId = (args?.clusterServiceAccount?.name || `${name}-cluster`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      const displayName = args?.clusterServiceAccount?.displayName || `${name} constellation cluster`;
      const sa = new gcp.serviceaccount.Account(`${name}-cluster`, {
        accountId,
        displayName,
      }, { parent: this });
      const key = new gcp.serviceaccount.Key(`${name}-cluster-key`, {
        serviceAccountId: sa.name,
      }, { parent: this });
      this.serviceAccountKey = key.privateKey;
      this.serviceAccountEmail = sa.email;
    }

    const outs: any = {};
    if (this.vmServiceAccountEmail) outs.vmServiceAccountEmail = this.vmServiceAccountEmail;
    if (this.serviceAccountKey) outs.serviceAccountKey = this.serviceAccountKey;
    if (this.serviceAccountEmail) outs.serviceAccountEmail = this.serviceAccountEmail;
    this.registerOutputs(outs);
  }
}


