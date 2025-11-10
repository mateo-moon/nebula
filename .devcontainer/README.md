# Dev Container for Nebula Pulumi Tests

This devcontainer provides an isolated environment for running Pulumi tests with all necessary tools pre-installed using Docker Compose and a custom Dockerfile.

## What's Included

- **Node.js 20** - Latest LTS version
- **TypeScript** - TypeScript compiler and language support
- **Pulumi CLI** - Pre-installed in Dockerfile
- **kubectl** - Kubernetes CLI tool
- **Helm** - Kubernetes package manager
- **vals** - Secret resolution tool (pre-installed in Dockerfile)

## Architecture

- **Dockerfile** - Custom Docker image with all dependencies installed
- **docker-compose.yml** - Orchestrates the container setup
- **devcontainer.json** - VS Code devcontainer configuration

## Setup

1. Open the workspace in VS Code
2. When prompted, click "Reopen in Container"
3. The container will automatically:
   - Build the Docker image with all tools
   - Mount your workspace
   - Install Node.js dependencies (`pnpm install`)
   - Set up environment variables

## Running Tests

Once the container is ready, you can run tests:

```bash
cd pulumi
npm run test
```

## Building the Container Manually

If you need to rebuild the container manually:

```bash
cd .devcontainer
docker-compose build
```

Or build just the Dockerfile:

```bash
docker build -f .devcontainer/Dockerfile -t nebula-test .
```

## Secrets

The `.secrets` directory is mounted from your local workspace, so SOPS-encrypted files are available for testing.

## Environment Variables

- `PULUMI_CONFIG_PASSPHRASE` - Set to `password` by default for testing
- `PATH` - Includes `/home/node/.pulumi/bin` for Pulumi CLI

## Troubleshooting

If the container fails to start:
1. Check Docker is running
2. Ensure port conflicts don't exist
3. Try rebuilding: `docker-compose build --no-cache`
