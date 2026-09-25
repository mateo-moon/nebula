# Module validation

`pnpm test` runs every `test/**/*.test.ts` file with the Node test runner.

- `ecr.test.ts` validates private ECR synthesis, repository retention, IAM
  access boundaries and keyless provider installation.
- `pack-import.test.ts` packs the package, installs the tarball into a clean
  project and imports the package root. It fails if a tracked file under
  `src/` or `imports/` (or a literal `new URL("./x", import.meta.url)` asset)
  is missing from the tarball, or if importing the package root reads a
  package file other than module sources, lists a directory or spawns a
  process. Assets must therefore be read lazily, inside functions. The test
  needs `pnpm` and registry access (or a warm pnpm store).

The GitHub `Verify modules` workflow runs these tests together with
`tsc --noEmit`, the Crossplane management-policy conventions
(`pnpm verify:policies`), the repository publication guard
(`node scripts/publication-guard.mjs`, tested by
`node --test scripts/publication-guard.test.mjs`) and a secret scan of the
pushed commits. Tests use synthetic identities and do not contact any cloud
API.
