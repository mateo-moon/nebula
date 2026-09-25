declare const digestImageBrand: unique symbol;

/**
 * A container image pinned by digest, exactly as it will be written into a
 * manifest: `<registry>/<path>@sha256:<64 lowercase hex>`.
 *
 * Measured guest policies bind the image reference string byte for byte, so
 * a DigestImage is only ever validated, never rewritten: no default registry,
 * no `library/` prefix, no case folding, no tag. The registry host is
 * required because a container runtime would otherwise expand a short name,
 * and the name it pulls would no longer be the name the policy binds.
 */
export type DigestImage = string & { readonly [digestImageBrand]: true };

// OCI distribution reference grammar (distribution/reference), restricted to
// references with an explicit registry host and a sha256 digest, no tag.
const HOST_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const HOST = `(?:${HOST_COMPONENT}(?:\\.${HOST_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*";
const NAME = new RegExp(`^(${HOST})/${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`);
const REFERENCE = /^([^@]+)@sha256:[a-f0-9]{64}$/;
const MAX_NAME_LENGTH = 255;

function refusal(ref: unknown): string | undefined {
  if (typeof ref !== "string") return `expected a string, got ${ref === null ? "null" : typeof ref}`;
  const reference = REFERENCE.exec(ref);
  if (!reference) return "expected repo@sha256:<64 lowercase hex> (tags and other digest algorithms are not accepted)";
  const name = reference[1];
  if (name.length > MAX_NAME_LENGTH) return `repository name longer than ${MAX_NAME_LENGTH} characters`;
  const parsed = NAME.exec(name);
  if (!parsed) return "repository is not a valid lowercase OCI repository name with a registry host";
  const host = parsed[1];
  if (!(host.includes(".") || host.includes(":") || host === "localhost")) {
    return `the first path component must be a registry host (for example ghcr.io/...), otherwise a runtime rewrites the name`;
  }
  return undefined;
}

/** True when `ref` is a valid {@link DigestImage}. */
export function isDigestImage(ref: unknown): ref is DigestImage {
  return refusal(ref) === undefined;
}

/**
 * Validate a digest-pinned image reference and return it unchanged.
 * @throws TypeError when the reference is not `<registry>/<path>@sha256:<64 hex>`.
 */
export function digestImage(ref: string): DigestImage {
  const reason = refusal(ref);
  if (reason !== undefined) {
    const shown = typeof ref === "string" ? JSON.stringify(ref.length > 120 ? `${ref.slice(0, 120)}...` : ref) : String(ref);
    throw new TypeError(`digestImage: ${shown}: ${reason}`);
  }
  return ref as DigestImage;
}
