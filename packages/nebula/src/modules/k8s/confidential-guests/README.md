# confidential-guests

Building blocks for workloads that run as confidential guests (for example
Kata Containers on AMD SEV-SNP): measured guest Pods that a per-role
controller creates and recovers, the signed release statements they verify,
and the admission, network and logging surface around them.

The module takes every deployment-specific value as a prop. Names, label
domains, payload types, policy names and messages have no defaults tied to a
particular deployment; where a default exists it is a neutral one (a sync
wave, a file name, a container entry point).

## Constructs

| Construct | Renders |
| --- | --- |
| `SignedReleases` | One ConfigMap per release authority and wire format, holding the DSSE envelopes a guest verifies. |
| `GuestLifecycle` | Per role: the spec, ledger, optional imported ledger, RBAC and the controller Deployment (code or image mode). |
| `GuestAdmissionFence` | Two ValidatingAdmissionPolicies with bindings: only the controllers create guests, only in their role's shape. |
| `GuestLogRetention` | A host-side collector that keeps guest container logs across guest replacements. |
| `GuestServices` | Ingress NetworkPolicies and Services, optionally at fixed cluster addresses. |
| `ConfidentialGuestStack` | All of the above in one namespace, wired together (see below). |

Helpers: `measuredGuest` (the synthesis gate for a measured template),
`initDataSha256`, `guestLifecycleSpec`, `lifecycleIgnoreDifferences`,
`lifecycleNames`, `lifecycleLabelKey`, `guestClaimPrefix`, plus the
foundations (`digestImage`, `canonicalJson`, `sha256Hex`, `WireProfile`,
`NEUTRAL_WIRE`, `wireProfileEnv`).

## Measured and unmeasured inputs

A guest template is measured: policy generation binds its canonical JSON and
init-data, and attestation binds the init-data's SHA-256 (HOST_DATA). Pass
templates through `measuredGuest(template, artifact)`, which refuses a
template that changed since its policy was generated and init-data that does
not hash to the recorded HOST_DATA. Nothing in this module rewrites a
template or an image reference.

Everything else (controller images, policies, Services, log collection) is
unmeasured host-side configuration and can change without a new release.

## Lifecycle controllers

Each role's controller reads `<role>-lifecycle-spec` (spec version 1, see
`GuestLifecycleSpec`), keeps its state in `<role>-lifecycle-ledger`, runs as
the ServiceAccount `<role>-lifecycle` and labels the guests it creates with
`<labelDomain>/lifecycle` (`holder` or `stage`). A template's data volume is
named `data`; a template may name `${DISK}` instead of a real claim, and the
controller substitutes the phase's claim.

- Code mode (`{ code, runtimeImage, package }`) mounts the controller files
  at `/opt/lifecycle/<package>` and runs `<package>.lifecycle.main()` on the
  pinned runtime image; the environment carries `LIFECYCLE_ROLE` and
  `LIFECYCLE_NAMESPACE`.
- Image mode (`{ image, command? }`) runs the controller image
  (`python3 -m confidential_guests.lifecycle` by default) and adds
  `LIFECYCLE_NODE_NAME`, `LIFECYCLE_RUNTIME_CLASS` and
  `LIFECYCLE_LABEL_DOMAINS` (a JSON list: the emitted domain first, then the
  domains in `acceptLabelDomains` that are only read).

Git declares each ledger once. Set `lifecycleIgnoreDifferences(...)` (or
`stack.ignoreDifferences()`) on the Argo CD Application so a sync never
resets one.

## Signed releases and wire formats

`payloadTypes` names each wire format's DSSE payload types and is required.
An authority renders one ConfigMap per format it signs in; two formats are
"dual envelopes" for readers that accept different payload types. Within a
format the construct refuses inconsistent statements: the reading guests'
authorities must carry the same payload bytes, one release-set sequence
names one payload, a set only non-reading guests see is never ahead, a
retiring authority signs only what an active one signs (or what its entry
pins), a retired one never renders, and every `expires_at` stays within the
authority's `cap`.

## The stack

`ConfidentialGuestStack` renders, in order: pull broker, signed releases,
Services, disks, key injector, log retention, admission fence, lifecycle
controllers. The controllers act as soon as they run, so everything their
guests need comes first. The stack derives the fence's controllers and
guests and the log scopes from the lifecycle roles, and passes
`ConfidentialGuestStackContext` (guest Pod names, claims and every release's
HOST_DATA) to the host components it takes as functions (`pullBroker`,
`disks`, `keyInjector`).

`example/confidential-guests-stack.ts` shows a complete stack with example values.

## Adopting an existing deployment

The constructs can reproduce an existing deployment's objects exactly: pass
its names, label domain, payload types, policy names, messages, waves and,
for its controllers, code mode with the code it runs today. The fence and
the stack assume nothing about names. Byte identity is checked by rendering
both and comparing, before anything is applied.
