# Module validation

`pnpm test` runs every `test/**/*.test.ts` file with the Node test runner.

- `ecr.test.ts` validates private ECR synthesis, repository retention, IAM
  access boundaries and keyless provider installation.
- `pack-import.test.ts` packs the package, installs the tarball into a clean
  project and imports the package root. It fails if a tracked file under
  `src/` or `imports/`, an existing `files` entry, or a literal
  `new URL("./x", import.meta.url)` asset is missing from the tarball, or if
  importing the package root does file I/O of its own: a read, listing, stat
  or write by package code or of package files, any access outside the
  installed dependencies (working directory, home, `/etc`, temporary
  directories), an eager non-code module import such as a JSON asset, or a
  process spawn. Only the module loader reading module sources is allowed, so
  assets must be read lazily, inside functions. The test needs `pnpm` and
  registry access (or a warm pnpm store).
- `confidential-guests-*.test.ts` cover the confidential-guests module with
  synthetic names only: each construct is rendered next to the same objects
  written as plain manifests (`support/cdk8s-render.ts`), and the two YAML
  outputs must be byte-identical, so a deployment written by hand can adopt
  a construct without a diff. `confidential-guests-example.test.ts` compares
  `example/confidential-guests.ts` with the committed render in
  `confidential-guests-golden/` (regenerate with `UPDATE_GOLDEN=1` after
  reviewing the change) and runs the publication guard over that render.
- `io-probe.test.ts` controls the probe behind that check
  (`support/io-probe.mjs`, a preload that records `node:fs`,
  `node:fs/promises` and `node:child_process` calls with their call stacks,
  and every module load through an in-thread `module.registerHooks` hook;
  Node 22.15 or later) and its classifier (`support/import-io.ts`): each kind
  of import-time I/O must be reported, and plain module loading must not.

The GitHub `Verify modules` workflow runs these tests together with
`tsc --noEmit`, the Crossplane management-policy conventions
(`pnpm verify:policies`), the repository publication guard
(`node scripts/publication-guard.mjs`, tested by
`node --test scripts/publication-guard.test.mjs`) and a secret scan of the
pushed commits. Tests use synthetic identities and do not contact any cloud
API.

The secret scan (gitleaks) does not read the guard's hash allowlist
(`scripts/publication-guard.allow.json`). A committed test key allowlisted
there also needs its gitleaks fingerprint in `.gitleaksignore`, added in the
same change.
