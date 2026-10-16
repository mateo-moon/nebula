# Trustee's native genpolicy profile

Base source: Kata Containers commit
`5b57d5c41ffb9d9515e76ef51cfa851068cfc439`, `src/tools/genpolicy`.
Upstream code is Apache-2.0; copyright notices are preserved.

`rules.rego` is the native rules file with the small, reviewable changes in
`upstream.patch`. `trustee.rego` adds application constraints. Both are supplied
to genpolicy **before** generation. Native genpolicy generates the image/process
data and the complete Init-Data annotation. No generated policy is rewritten.

- The upstream corrected guest-pull rule binds the actual requested image to
  its permitted digest. The compatibility rule additionally accepts the older
  CoCo metadata driver option only when it equals the request's entire OCI
  metadata; the image annotation must also match the permitted image.
- Exactly the declared processes, arguments, required environment, capabilities
  and guest tmpfs storage are allowed. Projected Kubernetes credentials are
  removed from native settings. Image roots remain read-only.
- Exec, streams, diagnostics, tracing, mutable policy and ephemeral mounts are
  disabled. Only bounded regular runtime metadata may be copied before the
  corresponding container exists, and never after both workloads are created.
- Initial network configuration is restricted by owner-configured CNI address
  patterns and independent loopback guards. Networking is frozen on creation
  of either application container. Start latches survive RemoveContainer, so
  restarting an application requires replacing the PodVM and reprovisioning.

The agent policy engine has no `net` builtins, so address rules use its supported
regex/numeric builtins. Network policies in Kubernetes are defense in depth.

`genpolicyInput` omits four explicitly known Kubernetes-only fields unsupported
by the generator: service-account automount, service links, pod runAsNonRoot and
pod seccompProfile. These remain in the Helm Deployment; UID, mounts and absence
of extra credentials are enforced by the generated guest policy. The broad
`--silent-unsupported-fields` option is never used.

These application constraints are Nebula integration, not a claim that upstream
genpolicy defaults alone provide administrator isolation. Any rules, generator,
runtime or image update needs renewed native policy and hardware qualification.

The provenance diff uses zero context (`git apply --unidiff-zero` against the
pinned source). Consumers use the bundled files directly.
