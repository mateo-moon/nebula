/**
 * ExternalDns - Automatic DNS record management for Kubernetes.
 * 
 * Providers are auto-injected from infrastructure stack (org/infrastructure/env).
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * import { ExternalDns } from 'nebula/k8s/external-dns';
 * 
 * setConfig({
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 * });
 * 
 * new ExternalDns('external-dns', {
 *   domainFilters: ['example.com'],
 *   policy: 'sync',
 * });
 * ```
 */
import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { BaseModule } from "../../../core/base-module";
import { getConfig } from "../../../core/config";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export type ExternalDnsProvider = 'google' | 'aws' | 'azure' | 'cloudflare';

export interface ExternalDnsConfig {
  namespace?: string;
  provider?: ExternalDnsProvider;
  domainFilters?: string[];
  txtOwnerId?: string;
  txtPrefix?: string;
  sources?: string[];
  policy?: 'sync' | 'upsert-only';
  registry?: 'txt' | 'noop';
  interval?: string;
  logLevel?: 'info' | 'debug' | 'error' | string;
  serviceAccountAnnotations?: Record<string, string>;
  googleProject?: string;
  extraArgs?: string[];
  values?: Record<string, unknown>;
  version?: string;
  repository?: string;
  gsaEmail?: string;
  gsaRoles?: string[];
  gsaRolesProjectId?: string;
  createDefaultDnsAdminRole?: boolean;
  args?: OptionalChartArgs;
}

export class ExternalDns extends BaseModule {
  public readonly chart: k8s.helm.v4.Chart;
  public readonly namespace: k8s.core.v1.Namespace;

  constructor(
    name: string,
    args: ExternalDnsConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('nebula:ExternalDns', name, args as unknown as Record<string, unknown>, opts, { needsGcp: true });

    // Get config for defaults
    const nebulaConfig = getConfig();
    
    const namespaceName = args.namespace || 'external-dns';
    const provider: ExternalDnsProvider = args.provider ?? 'google';
    const sources = args.sources && args.sources.length > 0 ? args.sources : ['service', 'ingress'];
    const policy = args.policy || 'upsert-only';
    const registry = args.registry || 'txt';
    const interval = args.interval || '1m';
    const logLevel = args.logLevel || 'info';
    const domainFilters = args.domainFilters ?? (nebulaConfig?.domain ? [nebulaConfig.domain] : []);

    this.namespace = new k8s.core.v1.Namespace(`${name}-namespace`, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const gcpProvider = this.getProvider('gcp:project:Project') as gcp.Provider | undefined;
    
    const clusterProject: pulumi.Output<string> | string | undefined = 
      args.googleProject || nebulaConfig?.gcpProject || gcpProvider?.project.apply(p => p || '');
    
    if (provider === 'google' && !clusterProject) {
      throw new Error('GCP project is required when provider is "google".');
    }

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
        const gsa = new gcp.serviceaccount.Account(`${name}-gsa`, {
          accountId,
          displayName: `${name} external-dns`,
        }, { parent: this });
        gsaEmailOut = gsa.email;
        gsaResourceIdOut = gsa.name;
      }

      new gcp.serviceaccount.IAMMember(`${name}-wi`, {
        serviceAccountId: gsaResourceIdOut!,
        role: 'roles/iam.workloadIdentityUser',
        member: pulumi.interpolate`serviceAccount:${clusterProject}.svc.id.goog[${namespaceName}/external-dns]`,
      }, { parent: this });

      const baseRoles = new Set<string>();
      if (args.createDefaultDnsAdminRole !== false) baseRoles.add('roles/dns.admin');
      (args.gsaRoles || []).forEach(r => { if (r) baseRoles.add(r); });
      const rolesProject = args.gsaRolesProjectId || clusterProject!;
      
      Array.from(baseRoles).forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-gsa-role-${idx}`, {
          project: rolesProject,
          role,
          member: gsaEmailOut!.apply(email => `serviceAccount:${email}`),
        }, { parent: this });
      });
    }

    const values: Record<string, unknown> = {
      provider,
      sources,
      policy,
      registry,
      interval,
      logLevel,
      tolerations: [
        { key: 'components.gke.io/gke-managed-components', operator: 'Exists', effect: 'NoSchedule' }
      ],
      ...(domainFilters.length > 0 ? { domainFilters } : {}),
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
      ...(provider === 'google' && clusterProject
        ? { extraArgs: [`--google-project=${clusterProject}`, ...(args.extraArgs || [])] }
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

    this.chart = new k8s.helm.v4.Chart(name, finalChartArgs, { 
      parent: this, 
      dependsOn: [this.namespace] 
    });

    this.registerOutputs({});
  }
}
