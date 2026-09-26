# Image-mode controller contract fixtures

These files pin what `GuestLifecycle` and `GuestLogRetention` render for a
controller image run in image mode (`{ image, command? }`). They are
nebula's own render of the example stack (`example/confidential-guests.ts`),
so a controller image that implements image mode can vendor them and test
against them: it must accept each spec and act on it, and must run with the
entry point, environment, security context and permissions given here.

| File | Content |
| --- | --- |
| `lifecycle-spec.operator.json` | the `spec.json` of the operator role's `<role>-lifecycle-spec`: spec version 2, no stage boot. One canonical line and a newline |
| `lifecycle-spec.primary.json` | the same for the primary role, with a stage boot and a template that names the claim placeholder |
| `controllers.json` | per role, the controller container's `command`, `env`, `securityContext`, its `serviceAccountName` and Role `rules`, its spec ConfigMap and key, and its ledger ConfigMap and key; and the same for the log collector |
| `MANIFEST.sha256` | the SHA-256 of each file above |

`confidential-guests-lifecycle-contract.test.ts` renders the example and
checks that these files are its output byte for byte, and pins the
manifest's own SHA-256. To change the contract, change the constructs,
regenerate the files with `UPDATE_LIFECYCLE_CONTRACT=1 pnpm test`, review
the diff, and update the pin in the same change.
