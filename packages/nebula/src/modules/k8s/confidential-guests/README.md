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
| `GuestAdmissionFence` | Two ValidatingAdmissionPolicies with bindings: only the controllers create guests, only in their role's shape, each mounting only its own claims. |
| `GuestLogRetention` | A host-side collector that keeps guest container logs across guest replacements. |
| `GuestServices` | Ingress NetworkPolicies and Services, optionally at fixed cluster addresses. |
| `AttestedPullBroker` | A Key Broker Service that releases private registry credentials only to guests whose attested init-data hash is admitted. |
| `SealedDisks` | Loop-file block disks from a disk table: a provisioner per live disk, optionally the key injector, and a local PersistentVolume and claim per declared disk. |
| `NriKeyInjector` | The NRI plugin that hands a key device to bound guest containers of its own namespace only. |
| `ConfidentialGuestStack` | All of the above in one namespace, wired together (see below). |

Helpers: `measuredGuest` (the synthesis gate for a measured template),
`initDataSha256`, `guestLifecycleSpec`, `lifecycleIgnoreDifferences`,
`lifecycleNames`, `lifecycleLabelKey`, `guestClaimPrefix`, the foundations
(`digestImage`, `canonicalJson`, `sha256Hex`) and the guest env renderers
(`wireProfileEnv`, `storageLayoutEnv`, `workloadApiEnv`, `guestEnv`,
`adapterModeEnv`, `sealedStorageEnv`, `readGuestEnv`, with the frozen
`NEUTRAL_WIRE`, `NEUTRAL_WORKLOAD_API` and `NEUTRAL_SEALED_STORAGE` names).

## Measured and unmeasured inputs

A guest template is measured: policy generation binds its canonical JSON and
init-data, and attestation binds the init-data's SHA-256 (HOST_DATA). Pass
templates through `measuredGuest(template, artifact)`, which refuses a
template that changed since its policy was generated and init-data that does
not hash to the recorded HOST_DATA. Nothing in this module rewrites a
template or an image reference.

Everything else (controller images, policies, Services, log collection) is
unmeasured host-side configuration and can change without a new release.

## The guest env contract

A guest learns which deployment it belongs to from three measured
environment variables. Its components (the attestation adapter, sealed
storage, a control bridge, observers) read them when they start, with the
rules below, and refuse to start on any violation. nebula renders them with
the same rules and reads back everything it renders, so a value a guest
would refuse fails the render with the guest's own message
(`GuestEnvError`, a `TypeError`).

| Variable | Renderer | Carries | Max |
| --- | --- | --- | --- |
| `GUEST_WIRE_PROFILE` | `wireProfileEnv(profile)` | payload types, byte domains, the release scope and roles, the Pod's workload reference | 16 KiB |
| `GUEST_STORAGE_LAYOUT` | `storageLayoutEnv(layout)` | the two sealed volumes, KDF labels, the lifecycle key request, the identity record file and formats | 8 KiB |
| `GUEST_WORKLOAD_API` | `workloadApiEnv(api)` | the adapter's mode, portal and verifier routes, signing and key-resolver domains | 4 KiB |

Every value is one line of canonical JSON (sorted keys, no whitespace,
integers only), bytes 0x20 to 0x7e, without `$` (the kubelet rewrites `$$`
and `$(NAME)` in env values). A value is refused, never repaired.

- **Wire profile.** `{domains, payloadTypes, releaseSet, workloadRef}`. Each
  identifier is `{emit, accept?}`, rendered as a list whose element 0 is
  emitted and whose every element is accepted; within a group a value
  belongs to one identifier. Payload types are
  `application/vnd.<schema>+json` with a lower-case schema. The session and
  control-bridge schemas derive from the `session` and
  `controlAuthorization` domains (lower case, `_` as `.`; a caller may name
  a control-bridge schema that predates this rule, see below), so no two
  authorization domains may derive one schema. `releaseSet.scope` entries
  are `field=value` (the emitted one is what signers write); `roles` include
  `node`. `workloadRef` is one exact string: it ties the adapter to its own
  workload in the same Pod, so two Pods of a deployment differ only there.
- **Storage layout.** The identity record's header and fingerprint domain
  belong to the disk, not the wire: `secrets.formats` lists them (the first
  is written, every one is read), so renaming wire identifiers never changes
  a guest's persistent identity. The adapter and the storage container of a
  Pod get the same layout (`sealedStorageEnv(layout, volume)` adds storage's
  `NODE_ID` and `VOLUME_ID`).
- **Workload API.** Peers of one deployment share it; the adapter's `MODE`
  must equal its `mode` (`adapterModeEnv(api)`).

`guestEnv({wire, storageLayout, workloadApi}, options?)` renders all three
for every container that reads them, in the order a guest reads them.
nebula renders no legacy default: a profile always names its `releaseSet`
and `workloadRef`, and the layout and API are always rendered.

A guest takes its built-in defaults when its env has none of these
variables, or when its wire profile still emits the guest's original
identifiers (a "dual" profile that may also accept renamed ones, with no
`releaseSet` or `workloadRef`). nebula renders neither by design. An
existing guest whose measured env has none of these variables is adopted by
rendering none of them. Moving such a guest to an env nebula renders means
an explicit profile, with its original values written out in full, and that
is a new measurement.

`readGuestEnv(env, reader?, options?)` reads an env as a guest's components
read it when they start, and returns the derived deployment (schemas, record
formats, the operator role). nebula holds no legacy identifiers, so it
applies the explicit-deployment rule to every profile: it refuses a dual
profile, and when `GUEST_WIRE_PROFILE` is unset it names that variable among
the missing pieces (a message of nebula's own; a guest would take its
built-in profile). `options` names what an existing deployment still
measures, because nebula assumes none of its names:

- `legacyWorkloadRefEnv`: the variable in which the deployment measured each
  Pod's workload reference before `workloadRef` existed. When the env sets
  it, it is read as the guest reads it (UTF-8, no `$`) and must equal
  `workloadRef`. It never stands in for `workloadRef`.
- `controlBridgeSchemas`: control-bridge schemas that predate the derivation
  rule, by the authorization domain that names them. `wireProfileEnv` and
  `guestEnv` take them too, so that the check that no two authorization
  domains derive one schema sees them. They are derived, never rendered.

The contract's neutral fixtures are vendored in
`test/confidential-guests-guest-env/`; the tests render the neutral names
and the example deployment byte for byte as those fixtures, and refuse every
refusal vector there with the reader's message.

## Lifecycle controllers

Each role's controller reads `<role>-lifecycle-spec` (see
`GuestLifecycleSpec`), keeps its state in `<role>-lifecycle-ledger`, runs as
the ServiceAccount `<role>-lifecycle` and labels the guests it creates with
`<labelDomain>/lifecycle` (`holder` or `stage`). A template's data volume is
named `data`; a template may name `${DISK}` instead of a real claim, and the
controller substitutes the phase's claim. Every claim belongs to one guest:
a stage boot's claim is never its holder's, and no two roles share a claim.

In both modes the environment carries only `LIFECYCLE_ROLE` and
`LIFECYCLE_NAMESPACE`; everything else comes from the spec in Git (see the
image-mode contract below).

- Code mode (`{ code, runtimeImage, package }`) mounts the controller files
  at `/opt/lifecycle/<package>` and runs `<package>.lifecycle.main()` on the
  pinned runtime image. The spec is version 1: the shipped controller knows
  its node, runtime class and label domain itself.
- Image mode (`{ image, command? }`) runs the controller image
  (`python3 -I -B -m confidential_guests.lifecycle` by default). The spec is
  version 2: version 1 plus `node_name`, `runtime_class_name` and
  `label_domains` (the emitted domain first, then the domains in
  `acceptLabelDomains` that are only read).

`requiredStageContainers` mirrors a controller that requires certain
containers in every stage boot; it is checked at render time and renders
nothing.

Git declares each ledger once. Set `lifecycleIgnoreDifferences(...)` (or
`stack.ignoreDifferences()`) on the Argo CD Application so a sync never
resets one.

### The image-mode controller contract

A controller image run in image mode (`{ image, command? }`), and a log
collector image (`GuestLogRetention` with `{ image, command? }`), implement
this contract. It is what the constructs render; it does not change with the
image.

**Status: not yet implemented.** No published controller image implements
this contract yet, so image mode renders a controller that nothing runs
today. Code mode, with spec version 1, is unaffected. The contract is
decided as written here: spec version 2 carries the node, the runtime class
and the label domains, and the environment carries nothing else.
`test/confidential-guests-lifecycle-contract/` pins it as nebula's render
of the example stack, byte for byte: both roles' specs (one with a stage
boot, one without), and each controller's and the log collector's entry
point, environment, security context and permissions. A controller image
vendors those files and tests against them, and a change to this contract
changes them in the same reviewed change.

- **Entry points.** `python3 -I -B -m confidential_guests.lifecycle`
  (`LIFECYCLE_CONTROLLER_COMMAND`) and
  `python3 -I -B -m confidential_guests.log_retention`
  (`LOG_RETENTION_COMMAND`), unless `command` names others. `-I` isolates
  the interpreter from the environment and the working directory; `-S` is
  left out because the image installs the package into site-packages.
- **Controller environment.** Exactly `LIFECYCLE_ROLE` (the role) and
  `LIFECYCLE_NAMESPACE`. The controller reads everything else from the spec.
- **Spec.** ConfigMap `<role>-lifecycle-spec`, key `spec.json`, canonical
  JSON (`GuestLifecycleSpec`), `version` 2: `role`, `holder_name`,
  `stage_name`, `generation`, `claims` (`data`, `stage`), `releases` (per
  release id: `template`, `init_data_sha256`, `stage_containers`),
  `current`, `previous`, `rollout_id`, `grace_seconds`, `containers`,
  `initializers`, `live` and `ready` (`[container, path, port]`),
  `startup_seconds`, `budget` (`epoch`, `limit`), `rollout` (`limit`,
  `stage_seconds`, `backoff_seconds`, `settle_seconds`), and in version 2
  `node_name`, `runtime_class_name` and `label_domains`. A controller refuses
  a version it does not know.
- **Label domains.** On every guest it creates the controller writes the
  lifecycle label `<domain>/lifecycle` (`holder` or `stage`) under every
  listed domain, and reads it under any of them; the create nonce annotation
  (`<domain>/create-nonce`) goes under `label_domains[0]` only. A domain is
  renamed in three changes: list the new one first with the old one after
  it, move the Services' and policies' selectors to the new one, then drop
  the old one.
- **Guests.** Created from a release's template, whose data volume `data`
  names the phase's claim or the claim placeholder (`${DISK}` by default)
  that the controller replaces with the holder's `claims.data` or the stage
  boot's `claims.stage`. The render has checked that every template runs on
  `node_name` with `runtime_class_name` and carries no Argo tracking id.
- **State.** The ledger ConfigMap `<role>-lifecycle-ledger` (`data.state`),
  which Git declares once and Argo never resets; an imported ledger, when the
  role names one, is read once.
- **Permissions.** The ServiceAccount `<role>-lifecycle` may get and delete
  only the holder and stage Pods, create Pods (the admission fence limits
  which), get its spec (and imported ledger) and get and patch its ledger.
  The container runs as uid 65532, non-root, with a read-only root
  filesystem, no capabilities and the runtime's default seccomp profile.
- **Log collector.** It reads `LOG_NAMESPACE` and `LOG_SCOPE`
  (`[[pod, [container, ...]], ...]` as JSON), may get `pods/log` of the
  listed Pods only, and writes under `/logs`.

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

## Sealed disks

`SealedDisks` renders, per live disk of its table, a privileged provisioner
that creates (once), checks and attaches the backing file; then, with
`injector`, the `NriKeyInjector` for the guests of these disks, in the same
namespace on the same node; then a local block PersistentVolume and claim
per declared disk (live and retained ones protected from pruning). A role's
size is its live generation's; a retained or declared generation made at
another size states it in the table (`sizeBytes` and `sizeLabel`), since
its claim cannot be resized. A stage placeholder's magic is printable ASCII
that `printf` takes literally, so it cannot start with `-`.

## The stack

`ConfidentialGuestStack` renders, in order: pull broker, signed releases,
Services, disks, key injector, log retention, admission fence, lifecycle
controllers. The controllers act as soon as they run, so everything their
guests need comes first. The stack derives the fence's controllers and
guests and the log scopes from the lifecycle roles.

The host components (`pullBroker`, `disks`, `keyInjector`) are given either
as their constructs' props or as functions:

- **Props.** The stack builds the construct in its namespace, on its node
  (and for the broker under its label domain), and ties it to its guests: the
  pull broker admits the HOST_DATA of every declared release; every guest's
  claim (holder and stage boot) must be a live disk of the disks' table; an
  injector binds only the stack's guest Pods. A prop the stack sets is
  refused. `SealedDisks` renders the key injector itself (`disks.injector`),
  so the `keyInjector` slot is only for a standalone `NriKeyInjector` beside
  disks the stack does not build; the stack refuses both at once.
- **Functions** `(scope, context) => void` receive
  `ConfidentialGuestStackContext` (guest Pod names, claims and every
  release's HOST_DATA) and build what they like.

The stack refuses two parts that render the same object, and a refusal
anywhere leaves nothing rendered.

## The admission fence

The policies are cluster-scoped, so the fence needs a `namespaceSelector`
that names its namespaces (a `matchLabels` entry or an `In` expression;
`NotIn`, `Exists` and `DoesNotExist` only narrow it). Each guest's claim
prefix starts with `guestClaimPrefix`, so the creator policy fences every
guest claim, and no guest's prefix covers another's, so a controller cannot
mount one guest's disk in another guest.

`example/confidential-guests.ts` shows a complete stack with example values:
two guests with their lifecycle controllers, signed releases, Services, log
retention and admission fence, the attested pull broker, sealed disks with
their key injector, and the full guest env.

## Adopting an existing deployment

The constructs can reproduce an existing deployment's objects exactly: pass
its names, label domain, payload types, policy names, messages, waves and,
for its controllers, code mode with the code it runs today. The fence and
the stack assume nothing about names. Byte identity is checked by rendering
both and comparing, before anything is applied.
