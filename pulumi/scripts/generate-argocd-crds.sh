#!/bin/bash
set -e

# Go to pulumi package root
cd "$(dirname "$0")/.."

OUTPUT_DIR="src/crossplane-crds/argocd"
mkdir -p "$OUTPUT_DIR"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading CRDs..."
CRDS=(
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/applications.argocd.crossplane.io_applications.yaml"
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/applicationsets.argocd.crossplane.io_applicationsets.yaml"
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/argocd.crossplane.io_providerconfigs.yaml"
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/cluster.argocd.crossplane.io_clusters.yaml"
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/projects.argocd.crossplane.io_projects.yaml"
  "https://raw.githubusercontent.com/crossplane-contrib/provider-argocd/main/package/crds/repositories.argocd.crossplane.io_repositories.yaml"
)

cd "$TEMP_DIR"
for url in "${CRDS[@]}"; do
  echo "Fetching $url"
  curl -sLO "$url"
done

echo "Generating Pulumi types..."
# Use --nodejsPath to target the output directory
crd2pulumi --nodejsPath "$OLDPWD/$OUTPUT_DIR" --force *.yaml

# Cleanup generated project files to treat it as source code
cd "$OLDPWD/$OUTPUT_DIR"
rm -f package.json tsconfig.json yarn.lock package-lock.json

echo "Done. Types generated in $OUTPUT_DIR"
