# Guest env contract fixtures

These files are the neutral part of the guest env contract's shared fixture
set, vendored byte for byte. The same bytes are read by the guest's own
readers (the attestation adapter and the in-guest tools), so
`confidential-guests-guest-env.test.ts` proves that what nebula renders is
what a guest reads, and that nebula refuses what a guest refuses, with the
guest's message.

| File | Content |
| --- | --- |
| `wire-profile.neutral.json` | `GUEST_WIRE_PROFILE` of the neutral example deployment: one canonical line and a newline |
| `storage-layout.neutral.json` | its `GUEST_STORAGE_LAYOUT` |
| `workload-api.neutral.json` | its `GUEST_WORKLOAD_API` (the neutral adapter's API) |
| `deployment.neutral.json` | the deployment's env, its adapter's `MODE`, what every reader derives from it, and the refusal vectors |
| `payload-types.json` | payload types every reader accepts, with the schema each names, and payload types every reader refuses |
| `MANIFEST.sha256` | the SHA-256 of each file above |

A refusal vector is `{name, reader, base, set?, setHex?, unset?, error | errorPrefix}`.
Its env is the `base` deployment's (`none`: no variable), with `set` applied,
then `setHex` (raw bytes in hex, for a value that is not UTF-8), then `unset`
removed. `reader` is who refuses it: `every` component, or only the `adapter`
(its `MODE`) or the control `bridge` (its one operator role). `error` is the
exact message; an invalid-JSON error ends in the parser's own detail, so it
gives only `errorPrefix`.

The test pins the manifest's own SHA-256. To update, copy the new files and
their manifest lines from the contract's fixture set, check that the
publication guard scans them clean, and change the pin in the same reviewed
change.
