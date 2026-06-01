import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
//

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export type ExternalDnsProvider = 'google' | 'aws' | 'azure' | 'cloudflare';

export interface ExternalDnsConfig {
  namespace?: string;
  provider?: ExternalDnsProvider;
  domainFilters?: string[];
  txtOwnerId?: string;
  txtPrefix?: string;
  sources?: string[]; // e.g., ['service','ingress']
  policy?: 'sync' | 'upsert-only';
  registry?: 'txt' | 'noop';
  interval?: string; // e.g., '1m'
  logLevel?: 'info' | 'debug' | 'error' | string;
  serviceAccountAnnotations?: Record<string, string>;
  googleProject?: string; // when provider=google
  extraArgs?: string[]; // raw passthrough args
  // Raw values to pass/override Helm chart values
  values?: Record<string, unknown>;
  // Helm chart version and repo
  version?: string;
  repository?: string;
  // GCP: bind KSA to a GSA via Workload Identity; provide the target GSA email
  gsaEmail?: string;
  // Optional additional roles to grant the GSA (defaults none here)
  gsaRoles?: string[];
  // Project for granting roles (defaults to current gcp project)
  gsaRolesProjectId?: string;
  // Whether to grant the default DNS admin role to the GSA (defaults to true)
  createDefaultDnsAdminRole?: boolean;
  args?: OptionalChartArgs;
}

export class ExternalDns extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ExternalDnsConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('external-dns', name, args, opts);

    const namespaceName = args.namespace || 'external-dns';
    const provider: ExternalDnsProvider = args.provider ?? 'google';
    const sources = args.sources && args.sources.length > 0 ? args.sources : ['service', 'ingress'];
    const policy = args.policy || 'upsert-only';
    const registry = args.registry || 'txt';
    const interval = args.interval || '1m';
    const logLevel = args.logLevel || 'info';

    const namespace = new k8s.core.v1.Namespace('external-dns-namespace', {
      metadata: { name: namespaceName },
    }, { parent: this });

    // Ensure a Google Service Account exists and is bound for Workload Identity (if provider is Google)
    const gcpCfg = new pulumi.Config('gcp');
    const clusterProject = gcpCfg.require('project');

    const normalizeAccountId = (raw: string): string => {
      let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!/^[a-z]/.test(s)) s = `a-${s}`;
      if (s.length < 6) s = (s + '-aaaaaa').slice(0, 6);
      if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
      return s;
    };

    const willUseGoogle = provider === 'google';

    let gsaEmailOut: pulumi.Output<string> | undefined = undefined;
    let gsaResourceIdOut: pulumi.Output<string> | undefined = undefined;
    if (willUseGoogle) {
      if (args.gsaEmail) {
        gsaEmailOut = pulumi.output(args.gsaEmail);
        gsaResourceIdOut = pulumi.interpolate`projects/${clusterProject}/serviceAccounts/${args.gsaEmail}`;
      } else {
        const accountId = normalizeAccountId(`${name}-external-dns`);
        const gsa = new gcp.serviceaccount.Account(`${name}-external-dns-gsa`, {
          accountId,
          displayName: `${name} external-dns`,
        }, { parent: this });
        gsaEmailOut = gsa.email;
        gsaResourceIdOut = gsa.name;
      }

      // Bind WI: allow KSA to impersonate GSA
      new gcp.serviceaccount.IAMMember(`${name}-external-dns-wi`, {
        serviceAccountId: gsaResourceIdOut!,
        role: 'roles/iam.workloadIdentityUser',
        member: pulumi.interpolate`serviceAccount:${clusterProject}.svc.id.goog[${namespaceName}/external-dns]`,
      }, { parent: this });

      // Grant DNS admin (plus any extra roles requested)
      const baseRoles = new Set<string>();
      if (args.createDefaultDnsAdminRole !== false) baseRoles.add('roles/dns.admin');
      (args.gsaRoles || []).forEach(r => { if (r) baseRoles.add(r); });
      const rolesProject = args.gsaRolesProjectId || clusterProject;
      Array.from(baseRoles).forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-external-dns-gsa-role-${idx}`, {
          project: rolesProject,
          role,
          member: gsaEmailOut!.apply(email => `serviceAccount:${email}`),
        }, { parent: this });
      });
    }

    // Build Helm values from high-level config + raw overrides
    const values: Record<string, unknown> = {
      provider,
      sources,
      policy,
      registry,
      interval,
      logLevel,
      tolerations: [
        { key: 'node.kubernetes.io/system', operator: 'Exists', effect: 'NoSchedule' }
      ],
      ...(args.domainFilters && args.domainFilters.length > 0 ? { domainFilters: args.domainFilters } : {}),
      ...(args.txtOwnerId ? { txtOwnerId: args.txtOwnerId } : {}),
      ...(args.txtPrefix ? { txtPrefix: args.txtPrefix } : {}),
      ...(args.serviceAccountAnnotations || willUseGoogle ? {
        serviceAccount: {
          create: true,
          name: 'external-dns',
          annotations: {
            ...(args.serviceAccountAnnotations || {}),
            ...(willUseGoogle && gsaEmailOut ? { 'iam.gke.io/gcp-service-account': gsaEmailOut } : {}),
          }
        }
      } : { serviceAccount: { create: true, name: 'external-dns' } }),
      ...(provider === 'google' && args.googleProject
        ? { extraArgs: [`--google-project=${args.googleProject}`, ...(args.extraArgs || [])] }
        : (args.extraArgs ? { extraArgs: args.extraArgs } : {})),
      ...(args.values || {}),
    };

    const defaultChartArgsBase: OptionalChartArgs = {
      chart: 'external-dns',
      repositoryOpts: { repo: args.repository || 'https://kubernetes-sigs.github.io/external-dns/' },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
    };
    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values,
    };
    new k8s.helm.v4.Chart('external-dns', finalChartArgs, { parent: this, dependsOn: [namespace] });

    // If a GSA email is provided, bind KSA to GSA via Workload Identity and optionally grant roles to the GSA
    if (args.gsaEmail) {
      const cfg = new pulumi.Config('gcp');
      const clusterProject = cfg.require('project');
      const gsaResourceName = pulumi.interpolate`projects/${clusterProject}/serviceAccounts/${args.gsaEmail}`;

      // Workload Identity user binding (let the KSA impersonate the GSA)
      new gcp.serviceaccount.IAMMember(`${name}-external-dns-wi`, {
        serviceAccountId: gsaResourceName,
        role: 'roles/iam.workloadIdentityUser',
        member: pulumi.interpolate`serviceAccount:${clusterProject}.svc.id.goog[${namespaceName}/external-dns]`,
      }, { parent: this });

      // Optional roles for the GSA (e.g., roles/dns.admin)
      const roles = (args.gsaRoles || []).filter(Boolean);
      const rolesProject = args.gsaRolesProjectId || clusterProject;
      roles.forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-external-dns-gsa-role-${idx}`, {
          project: rolesProject,
          role,
          member: pulumi.interpolate`serviceAccount:${args.gsaEmail}`,
        }, { parent: this });
      });
    }

    this.registerOutputs({});
  }
}