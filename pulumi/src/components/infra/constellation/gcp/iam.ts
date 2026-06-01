import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { defaultValues } from '../index';

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
    roles?: string[]; // optional override; defaults to Constellation-required compute privileges
  };
  uid?: pulumi.Input<string>;
}

export class ConstellationGcpIam extends pulumi.ComponentResource {
  public readonly vmServiceAccountEmail?: pulumi.Output<string>;
  public readonly serviceAccountKey?: pulumi.Output<string>;
  public readonly serviceAccountEmail?: pulumi.Output<string>;

  constructor(name: string, args?: ConstellationGcpIamConfig, opts?: pulumi.ComponentResourceOptions) {
    super('gcpIam', name, args, opts);

    const wantVmSa = args?.vmServiceAccount?.enabled !== false;
    if (wantVmSa) {
      const cfg = new pulumi.Config('gcp');
      const project = args?.vmServiceAccount?.projectId || cfg.require('project');
      const accountId = args?.uid 
        ? pulumi.interpolate`${args?.vmServiceAccount?.name || `${name}-vm`}-${args.uid}`.apply(id => id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30))
        : (args?.vmServiceAccount?.name || `${name}-vm`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      const displayName = args?.vmServiceAccount?.displayName || `${name} constellation VMs`;

      const sa = new gcp.serviceaccount.Account(`${name}-vm`, {
        accountId,
        displayName,
      }, { parent: this });

      const roles = (args?.vmServiceAccount?.roles && args.vmServiceAccount.roles.length > 0)
        ? args.vmServiceAccount.roles
        : defaultValues.gcp?.iam?.vmServiceAccount?.roles ?? [
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

      // Create a project-level custom role for VM instances with least-privileged read/list permissions Constellation expects
      // Role id must not contain dashes
      const roleIdBase = pulumi.output(accountId).apply(id => `${id}-role`.replace(/-/g, '_').slice(0, 64));
      const vmCustomRole = new gcp.projects.IAMCustomRole(`${name}-vm-custom-role`, {
        project,
        roleId: roleIdBase,
        title: pulumi.interpolate`${name} Constellation IAM role for VMs`,
        description: 'Constellation IAM role for VMs',
        permissions: [
          'compute.instances.get',
          'compute.instances.list',
          'compute.subnetworks.get',
          'compute.globalForwardingRules.list',
          'compute.zones.list',
          'compute.forwardingRules.list',
        ],
        stage: 'GA',
      }, { parent: this });
      // Bind the custom role to the VM service account
      new gcp.projects.IAMMember(`${name}-vm-custom-role-bind`, {
        project,
        role: pulumi.interpolate`projects/${project}/roles/${vmCustomRole.roleId}`,
        member: pulumi.interpolate`serviceAccount:${sa.email}`,
      }, { parent: this, dependsOn: [vmCustomRole] });

      this.vmServiceAccountEmail = sa.email;
    }

    // Create cluster SA and a JSON key for constellation provider input
    const wantClusterSa = args?.clusterServiceAccount?.enabled !== false;
    if (wantClusterSa) {
      const cfg = new pulumi.Config('gcp');
      const project = args?.clusterServiceAccount?.projectId || cfg.require('project');
      const accountId = args?.uid 
        ? pulumi.interpolate`${args?.clusterServiceAccount?.name || `${name}-cluster`}-${args.uid}`.apply(id => id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30))
        : (args?.clusterServiceAccount?.name || `${name}-cluster`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
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

      // Attach required roles so Constellation microservices can manage L4 load balancers, instance groups, health checks, and networking
      const clusterRoles = (args?.clusterServiceAccount?.roles && args.clusterServiceAccount.roles.length > 0)
        ? args.clusterServiceAccount.roles
        : defaultValues.gcp?.iam?.clusterServiceAccount?.roles ?? [
            'roles/compute.instanceAdmin.v1',
            'roles/compute.networkAdmin',
            'roles/compute.securityAdmin',
            'roles/compute.loadBalancerAdmin',
            'roles/compute.viewer',
            'roles/iam.serviceAccountUser',
          ];
      clusterRoles.forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-cluster-role-${idx}`, {
          project,
          role,
          member: pulumi.interpolate`serviceAccount:${sa.email}`,
        }, { parent: this });
      });
    }

    const outs: any = {};
    if (this.vmServiceAccountEmail) outs.vmServiceAccountEmail = this.vmServiceAccountEmail;
    if (this.serviceAccountKey) outs.serviceAccountKey = this.serviceAccountKey;
    if (this.serviceAccountEmail) outs.serviceAccountEmail = this.serviceAccountEmail;
    this.registerOutputs(outs);
  }
}


