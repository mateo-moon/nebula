/**
 * Utility functions for Nebula.
 */

export { resolveSecrets, hasUnresolvedSecrets, setSecretResolutionMode } from './secrets';
export {
  OWNED_POLICIES,
  FOLLOWER_POLICIES,
  OBSERVE_POLICIES,
  dataVolumePolicies,
  asPolicies,
} from './crossplane-policies';
export { mergeKsmValues } from './ksm';
export { isMainModule } from "./module-entry";

export { validateOidcHttpsUrl, validateOidcIssuer, oidcTokenLifetimeSeconds } from "./oidc";
export type { OidcIssuer } from "./oidc";

export { machineHtpasswd, MACHINE_PASSWORD_MIN_LENGTH } from "./htpasswd";
export type { BasicAuthAccount, MachineHtpasswdOptions } from "./htpasswd";
