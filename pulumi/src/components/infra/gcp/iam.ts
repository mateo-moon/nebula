import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface IamConfig {
  externalDns?: {
    enabled?: boolean;
    namespace?: string;          // KSA namespace (e.g., kube-system)
    ksaName?: string;            // KSA name (e.g., external-dns)
    gsaName?: string;            // Desired GSA accountId (without domain), defaults to <name>-external-dns
    roles?: string[];            // Project roles to grant to GSA, defaults to ['roles/dns.admin']
    workloadIdentity?: boolean;  // Bind WI user role, defaults to true
    projectId?: string;          // Optional project for role grants (defaults to top-level projectId)
  };
  certManager?: {
    enabled?: boolean;
    namespace?: string;          // KSA namespace (e.g., cert-manager)
    ksaName?: string;            // KSA name (e.g., cert-manager)
    gsaName?: string;            // Desired GSA accountId, defaults to <name>-cert-manager
    roles?: string[];            // Defaults to ['roles/dns.admin'] (same rights)
    workloadIdentity?: boolean;  // Defaults to true
    projectId?: string;          // Optional project for role grants (defaults to top-level projectId)
  }
}

export class Iam extends pulumi.ComponentResource {
  public readonly externalDnsGsaEmail?: pulumi.Output<string>;
  public readonly certManagerGsaEmail?: pulumi.Output<string>;

  constructor(name: string, args?: IamConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:gcp:Iam', name, args, opts);

    const cfg = new pulumi.Config()
    const wantExternalDns = !!args?.externalDns && args.externalDns.enabled !== false;
    const wantCertManager = !!args?.certManager && args.certManager.enabled !== false;
    if (!wantExternalDns && !wantCertManager) {
      this.registerOutputs({});
      return;
    }

    const clusterProject = cfg.require('gcp:project');

    const normalizeAccountId = (raw: string): string => {
      let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!/^[a-z]/.test(s)) s = `a-${s}`; // must start with a letter
      if (s.length < 6) s = (s + '-aaaaaa').slice(0, 6);
      if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
      return s;
    };

    const makeSaWithBindings = (
      kind: 'external-dns' | 'cert-manager',
      spec: { enabled?: boolean; namespace?: string; ksaName?: string; gsaName?: string; roles?: string[]; workloadIdentity?: boolean; projectId?: string } | undefined,
      rolesProject: string,
      clusterProjectForWi: string,
    ): pulumi.Output<string> | undefined => {
      if (!spec || spec.enabled === false) return undefined;
      const ns = spec.namespace || (kind === 'external-dns' ? 'external-dns' : 'cert-manager');
      const ksa = spec.ksaName || (kind === 'external-dns' ? 'external-dns' : 'cert-manager');
      const accountId = normalizeAccountId(spec.gsaName || `${name}-${kind}`);

      const gsa = new gcp.serviceaccount.Account(`${name}-${kind}-gsa`, {
        accountId,
        displayName: `${name} ${kind}`,
      }, { parent: this });

      const roles = (spec.roles && spec.roles.length > 0) ? spec.roles : ['roles/dns.admin'];
      roles.forEach((role, idx) => {
        new gcp.projects.IAMMember(`${name}-${kind}-role-${idx}`, {
          project: rolesProject,
          role,
          member: pulumi.interpolate`serviceAccount:${gsa.email}`,
        }, { parent: this });
      });

      const wi = spec.workloadIdentity !== false;
      if (wi) {
        const wiMember = pulumi.interpolate`serviceAccount:${clusterProjectForWi}.svc.id.goog[${ns}/${ksa}]`;
        new gcp.serviceaccount.IAMMember(`${name}-${kind}-wi`, {
          serviceAccountId: gsa.name,
          role: 'roles/iam.workloadIdentityUser',
          member: wiMember,
        }, { parent: this });
      }

      return gsa.email;
    };

    const edRolesProject = args?.externalDns?.projectId || clusterProject;
    const cmRolesProject = args?.certManager?.projectId || clusterProject;

    this.externalDnsGsaEmail = makeSaWithBindings('external-dns', args?.externalDns, edRolesProject, clusterProject);
    this.certManagerGsaEmail = makeSaWithBindings('cert-manager', args?.certManager, cmRolesProject, clusterProject);

    this.registerOutputs({
      externalDnsGsaEmail: this.externalDnsGsaEmail,
      certManagerGsaEmail: this.certManagerGsaEmail,
    });
  }
}


