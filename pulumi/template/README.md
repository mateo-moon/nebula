Nebula Pulumi Template

This template bootstraps a Pulumi Automation API project using the Nebula package.

Quickstart

1. Copy this folder to a new repo or directory
2. Install deps: pnpm i (or npm i / yarn)
3. Set config and run: pnpm ts-node src/index.ts up

Notes

- Requires vals and sops installed if you reference ref+sops:// in workspace config
- Set secretsProvider to a gcpkms://... URL to auto-bootstrap the KMS key and .sops.yaml

