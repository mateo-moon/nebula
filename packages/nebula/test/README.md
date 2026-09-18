# Module validation

`pnpm exec tsx --test test/ecr.test.ts` validates private ECR synthesis,
repository retention, IAM access boundaries and keyless provider installation.
The GitHub `Verify private ECR module` workflow also checks TypeScript and the
Crossplane management-policy conventions. Tests use synthetic identities and
do not contact AWS.
