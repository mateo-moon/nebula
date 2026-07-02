import type { IConstruct } from "constructs";
import { Provider as CpProvider } from "#imports/pkg.crossplane.io";
import { ARGOCD_KEEP_ON_DELETE } from "../../core";

export interface ProviderFamilyOptions {
  /** Provider name prefix (e.g. "provider-gcp" / "provider-aws"). */
  namePrefix: string;
  /** Provider package version (e.g. "v2.4.0"). */
  version: string;
  /** Cloud, used in the package name (`provider-<cloud>-<family>`). */
  cloud: "gcp" | "aws";
  /**
   * Optional Crossplane `runtimeConfigRef.name`. GCP passes this when
   * deterministic service accounts are enabled; AWS omits it.
   */
  runtimeConfigRef?: string;
  /** Constructs the resulting Provider must depend on (GCP runtime configs). */
  dependsOn?: IConstruct[];
}

/**
 * Create one Crossplane Upbound provider family and return it. Shared by
 * {@link GcpProvider} and {@link AwsProvider} so the package-naming convention,
 * the `ARGOCD_KEEP_ON_DELETE` annotation, and the optional `runtimeConfigRef`
 * wiring live in one place. Output is byte-identical to each provider's prior
 * hand-rolled `new CpProvider(...)`.
 */
export function createProviderFamily(
  scope: IConstruct,
  family: string,
  id: string,
  opts: ProviderFamilyOptions,
): CpProvider {
  const provider = new CpProvider(scope, id, {
    metadata: {
      name: `${opts.namePrefix}-${family}`,
      annotations: ARGOCD_KEEP_ON_DELETE,
    },
    spec: {
      package: `xpkg.upbound.io/upbound/provider-${opts.cloud}-${family}:${opts.version}`,
      ...(opts.runtimeConfigRef
        ? { runtimeConfigRef: { name: opts.runtimeConfigRef } }
        : {}),
    },
  });
  if (opts.dependsOn) {
    for (const dep of opts.dependsOn) provider.node.addDependency(dep);
  }
  return provider;
}
