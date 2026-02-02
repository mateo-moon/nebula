#!/usr/bin/env npx tsx
/// <reference types="node" />
/**
 * Generates typed claim classes from XRD schemas.
 * 
 * 1. Synths the XRD
 * 2. Extracts openAPIV3Schema from XRD
 * 3. Converts to standard CRD format
 * 4. Runs cdk8s import to generate TypeScript types
 * 
 * Usage: npx tsx scripts/generate-claim-types.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { parseAllDocuments, stringify } from 'yaml';

// Step 1: Synth the XRD
console.log('📦 Synthesizing XRD...');
execSync('npx cdk8s synth --app "npx tsx examples/xrd-infrastructure.ts"', { 
  stdio: 'inherit',
  cwd: process.cwd() 
});

// Step 2: Read and parse the XRD (only the CompositeResourceDefinition, skip Composition with templates)
console.log('📖 Reading XRD...');
const xrdContent = readFileSync('dist/gcp-infra-xrd.k8s.yaml', 'utf-8');

// Split by --- and parse each document separately, catching errors
const rawDocs = xrdContent.split(/\n---\n/);
let xrd: any = null;

for (const rawDoc of rawDocs) {
  // Quick check if this looks like a CompositeResourceDefinition
  if (rawDoc.includes('CompositeResourceDefinition') && !rawDoc.includes('GoTemplate')) {
    try {
      const docs = parseAllDocuments(rawDoc);
      for (const doc of docs) {
        const obj = doc.toJS();
        if (obj?.kind === 'CompositeResourceDefinition') {
          xrd = obj;
          break;
        }
      }
    } catch (e) {
      // Skip documents that fail to parse (like Composition with go-templates)
      continue;
    }
  }
  if (xrd) break;
}

if (!xrd) {
  console.error('❌ No CompositeResourceDefinition found in output');
  process.exit(1);
}

// Step 3: Convert XRD to CRD format
console.log('🔄 Converting XRD to CRD...');
const claimNames = xrd.spec.claimNames;
const version = xrd.spec.versions[0];

const crd = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: {
    name: `${claimNames.plural}.${xrd.spec.group}`,
  },
  spec: {
    group: xrd.spec.group,
    names: {
      kind: claimNames.kind,
      plural: claimNames.plural,
      singular: claimNames.kind.toLowerCase(),
    },
    scope: 'Namespaced',
    versions: [
      {
        name: version.name,
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: 'object',
            required: ['spec'],
            properties: {
              spec: {
                ...version.schema.openAPIV3Schema.properties.spec,
                // Add writeConnectionSecretToRef (Crossplane standard)
                properties: {
                  ...version.schema.openAPIV3Schema.properties.spec.properties,
                  writeConnectionSecretToRef: {
                    type: 'object',
                    description: 'Write connection secret to this reference',
                    properties: {
                      name: { type: 'string', description: 'Secret name' },
                      namespace: { type: 'string', description: 'Secret namespace' },
                    },
                  },
                },
              },
              status: version.schema.openAPIV3Schema.properties.status || { type: 'object' },
            },
          },
        },
      },
    ],
  },
};

// Write CRD to crds folder
mkdirSync('crds', { recursive: true });
const crdPath = `crds/${claimNames.plural}.${xrd.spec.group}.yaml`;
writeFileSync(crdPath, stringify(crd));
console.log(`✅ Generated CRD: ${crdPath}`);

// Step 4: Import with cdk8s
console.log('🚀 Importing CRD with cdk8s...');
execSync(`npx cdk8s import ${crdPath} --output imports/claims`, {
  stdio: 'inherit',
  cwd: process.cwd(),
});

console.log('✅ Done! Generated typed claim classes in imports/claims/');
