import { Construct } from "constructs";
import { Composition, CompositionSpecMode } from "#imports/apiextensions.crossplane.io";
import { baremetalWorkerTemplate } from "./template";

export interface BaremetalAdmissionRetirementConfig {
  name: string;
  /** Validated public profile from the host's bound revision. Retain its
   * installer, script reference, enrollment manifests and installation intent. */
  sourceProfile: Record<string, unknown>;
}

/** Retire a bound host's remote Node admission without generating a new
 * installer or changing the immutable installation request. Existing remote
 * admission Objects must be retired with the reviewed deletion policy first. */
export class BaremetalAdmissionRetirement extends Construct {
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, config: BaremetalAdmissionRetirementConfig) {
    super(scope, id);
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(config.name)) throw new Error("Baremetal retirement requires a 2–40 character composition name");
    const profile = structuredClone(config.sourceProfile);
    const provider = profile.workloadKubeProviderConfigName;
    const prefix = profile.ipv6PodCidrPrefix;
    if (typeof provider !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(provider) ||
        typeof prefix !== "string" || !/^[a-f0-9]{1,4}:[a-f0-9]{1,4}::$/.test(prefix) || profile.installationContext !== undefined) {
      throw new Error("Baremetal retirement requires the original profile with its legacy provider and /32 pod prefix");
    }
    if (typeof profile.image !== "string" || !/@sha256:[a-f0-9]{64}$/.test(profile.image) ||
        typeof profile.scriptsName !== "string" || !profile.scriptsName || !profile.installation || !profile.ssh ||
        !Array.isArray(profile.enrollment) || profile.enrollment.map(r => r.kind).join(",") !==
        "PooledRemoteMachine,RemoteMachineTemplate,K0sWorkerConfigTemplate,MachineDeployment") {
      throw new Error("Baremetal retirement requires the complete original installation and enrollment profile");
    }
    // The two strings remain solely as historical receipt context. Neither
    // activates a workload ProviderConfig or native admission output anymore.
    profile.installationContext = { workloadProvider: provider, podPrefix: prefix };
    delete profile.workloadKubeProviderConfigName;
    delete profile.ipv6PodCidrPrefix;
    this.composition = new Composition(this, "composition", {
      metadata: { name: config.name, annotations: { "argocd.argoproj.io/sync-wave": "-5" } },
      spec: { compositeTypeRef: { apiVersion: "nebula.io/v1alpha1", kind: "XBaremetalWorker" }, mode: CompositionSpecMode.PIPELINE,
        pipeline: [{ step: "install-and-enroll", functionRef: { name: "function-go-templating" }, input: {
          apiVersion: "gotemplating.fn.crossplane.io/v1beta1", kind: "GoTemplate", source: "Inline",
          inline: { template: baremetalWorkerTemplate(profile) },
        } }, { step: "auto-ready", functionRef: { name: "function-auto-ready" } }],
      },
    });
  }
}
