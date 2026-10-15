import { hasUnresolvedSecrets } from "../../../utils/secrets";

/** Trustee configuration is public, measured input. Reject references before
 * BaseConstruct can resolve them using credentials from the synthesis host. */
export function publicConfig<T>(owner: string, config: T): T {
  if (hasUnresolvedSecrets(config)) {
    throw new TypeError(`${owner}: supply literal public configuration; host-side ref+ resolution is forbidden`);
  }
  return config;
}
