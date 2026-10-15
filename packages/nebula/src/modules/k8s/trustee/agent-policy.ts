/** The only file-copy exception this module accepts. It admits small runtime
 * metadata before container creation; it cannot overwrite Trustee files or
 * change a running container. Use with the reviewed generator's pstate tracking. */
export const TRUSTEE_STARTUP_METADATA_POLICY = `CopyFileRequest if {
    input.file_type == "Regular"
    input.offset == 0
    input.file_size >= 0
    input.file_size <= 65536
    regex.match("^/run/kata-containers/shared/containers(?:/passthrough)?/(watchable/)?[a-z0-9]{64}-[a-z0-9]{16}-(resolv[.]conf|hosts|hostname|termination-log)$", input.path)
    ids := regex.find_n("[a-z0-9]{64}", input.path, 1)
    count(ids) == 1
    not data.pstate[ids[0]]
    not data.pstate.trustee
}
`;

export const TRUSTEE_DENIED_AGENT_REQUESTS = [
  "ExecProcessRequest", "ReadStreamRequest", "WriteStreamRequest", "SetPolicyRequest",
  "GetDiagnosticDataRequest", "AddSwapRequest", "UpdateEphemeralMountsRequest",
  "AddSwapPathRequest", "StartTracingRequest", "AllowRequestsFailingPolicy",
] as const;

// Remove comments and string contents without treating # inside strings as a
// comment. This is a conservative source gate, NOT a Rego semantic verifier.
function codeOnly(source: string): string {
  return source.replace(/"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|#[^\n]*/g,
    value => value.replace(/[^\n]/g, " "));
}

/** Refuse obvious accidental widening in an owner-reviewed genpolicy artifact.
 * The owner must still qualify creation/image/argv/env/mount rules with the
 * actual Kata policy engine. A matching hash does not prove those semantics. */
export function validateTrusteeAgentPolicy(policy: string): void {
  if (typeof policy !== "string" || policy.length > 800_000) throw new TypeError("Trustee: invalid agent policy");
  const code = codeOnly(policy);
  if ((code.match(/\bpackage\b/g) ?? []).length !== 1 || !/^\s*package agent_policy\s*$/m.test(code) ||
      !/^\s*default CreateContainerRequest\s*:?=\s*false\s*$/m.test(code)) {
    throw new TypeError("Trustee: reviewed agent_policy must deny container creation by default");
  }
  for (const request of TRUSTEE_DENIED_AGENT_REQUESTS) {
    if ((code.match(new RegExp(`\\b${request}\\b`, "g")) ?? []).length !== 1 ||
        !new RegExp(`^\\s*default ${request}\\s*:?=\\s*false\\s*$`, "m").test(code)) {
      throw new TypeError(`Trustee: agent policy must unconditionally deny ${request}`);
    }
  }
  const copy = codeOnly(policy.replace(TRUSTEE_STARTUP_METADATA_POLICY, ""));
  if ((copy.match(/\bCopyFileRequest\b/g) ?? []).length !== 1 ||
      !/^\s*default CopyFileRequest\s*:?=\s*false\s*$/m.test(copy)) {
    throw new TypeError("Trustee: CopyFileRequest may only allow the bounded startup metadata rule");
  }
}
