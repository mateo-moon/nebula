import type { ConfidentialImageStore } from "./types";

const label = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
const component = "[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?";
export const imageStoreRepositoryPattern = `^${component}/${component}$`;
export const imageStoreReadEndpointPattern = `^http://${label}[.]${component}[.]svc:8084$`;
export const imageStoreWriteEndpointPattern = `^http://${label}[.]${component}[.]svc:8085$`;

/** The entire tuple is measured configuration, never a discovery-provided override. */
export function validateImageStore(value: unknown, repository?: string): asserts value is ConfidentialImageStore {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "endpoint,repository,writeEndpoint") {
    throw new TypeError("Image store requires only public endpoint, writeEndpoint and repository");
  }
  const store = value as ConfidentialImageStore;
  if (typeof store.endpoint !== "string" || typeof store.writeEndpoint !== "string" || typeof store.repository !== "string" ||
      !new RegExp(imageStoreReadEndpointPattern).test(store.endpoint) ||
      !new RegExp(imageStoreWriteEndpointPattern).test(store.writeEndpoint) ||
      !new RegExp(imageStoreRepositoryPattern).test(store.repository) ||
      store.writeEndpoint !== store.endpoint.replace(/:8084$/, ":8085") ||
      (repository !== undefined && store.repository !== repository)) {
    throw new TypeError("Image store requires one exact HTTP service on 8084/8085 and the declared namespace/workload repository");
  }
}

export function imageStorePrefix(store: ConfidentialImageStore): string {
  validateImageStore(store);
  return `${new URL(store.endpoint).host}/${store.repository}`;
}

export function imageStoreImage(store: ConfidentialImageStore): string {
  return `${imageStorePrefix(store)}:release`;
}

export function imageStoreRegistry(store: ConfidentialImageStore) {
  const prefix = imageStorePrefix(store);
  return { prefix, location: prefix, insecure: true as const };
}

/** Fence DNS-case, trailing-dot and numeric-port aliases before a native
 * authority-scoped transport flag can affect another repository. */
export function imageStoreAuthorityMatches(reference: string, store: ConfidentialImageStore): boolean {
  const slash = reference.indexOf("/"), authority = slash < 0 ? reference : reference.slice(0, slash);
  try {
    const candidate = new URL(`http://${authority}`), expected = new URL(store.endpoint);
    return candidate.hostname.replace(/[.]$/, "").toLowerCase() === expected.hostname && candidate.port === expected.port;
  } catch { return false; }
}

export function assertImageStoreImage(image: string, store: ConfidentialImageStore, digest = false): void {
  const prefix = imageStorePrefix(store);
  if (digest ? !image.startsWith(`${prefix}@sha256:`) || !/^sha256:[a-f0-9]{64}$/.test(image.slice(prefix.length + 1))
    : image !== `${prefix}:release`) throw new TypeError("Image store image must use its exact repository and release or measured digest");
}
