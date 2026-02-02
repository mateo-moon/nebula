#!/usr/bin/env npx tsx
/// <reference types="node" />
/**
 * Generates typed claim classes from XRD schemas.
 * 
 * 1. Synths all XRDs
 * 2. Extracts openAPIV3Schema from each XRD
 * 3. Converts to standard CRD format
 * 4. Runs cdk8s import to generate TypeScript types
 * 
 * Usage: npx tsx scripts/generate-claim-types.ts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { parseAllDocuments, stringify } from 'yaml';

// Step 1: Synth all XRDs
console.log('📦 Synthesizing XRDs...');
execSync('npx cdk8s synth --app "npx tsx examples/all-xrds.ts"', { 
  stdio: 'inherit',
  cwd: process.cwd() 
});

// Step 2: Process each XRD file
console.log('📖 Processing XRDs...');

const distFiles = readdirSync('dist').filter(f => f.endsWith('.k8s.yaml'));
const claimImports: string[] = [];

for (const file of distFiles) {
  const filePath = `dist/${file}`;
  const content = readFileSync(filePath, 'utf-8');
  
  // Split by --- and parse each document separately
  const rawDocs = content.split(/\n---\n/);
  
  for (const rawDoc of rawDocs) {
    // Skip documents with go-template syntax
    if (rawDoc.includes('{{') || rawDoc.includes('GoTemplate')) {
      continue;
    }
    
    // Quick check if this looks like a CompositeResourceDefinition
    if (!rawDoc.includes('CompositeResourceDefinition')) {
      continue;
    }
    
    try {
      const docs = parseAllDocuments(rawDoc);
      for (const doc of docs) {
        const obj = doc.toJS();
        if (obj?.kind !== 'CompositeResourceDefinition') continue;
        
        const xrd = obj;
        const claimNames = xrd.spec.claimNames;
        if (!claimNames) continue;
        
        const version = xrd.spec.versions[0];
        
        console.log(`🔄 Converting ${claimNames.kind}...`);
        
        // Create CRD from XRD
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
                        // Add compositionRef if not present (for version selection)
                        properties: {
                          ...version.schema.openAPIV3Schema.properties.spec.properties,
                          compositionRef: version.schema.openAPIV3Schema.properties.spec.properties?.compositionRef || {
                            type: 'object',
                            description: 'Reference to a specific composition version',
                            properties: {
                              name: { type: 'string', description: 'Composition name' },
                            },
                          },
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
        const crdFileName = `${claimNames.plural}.${xrd.spec.group}.yaml`;
        const crdPath = `crds/${crdFileName}`;
        writeFileSync(crdPath, stringify(crd));
        console.log(`   ✅ Generated CRD: ${crdPath}`);
        
        // Import with cdk8s
        const importName = claimNames.kind.toLowerCase();
        const claimFile = `imports/${importName}-claim.ts`;
        
        // Remove existing file/directory if exists
        try {
          execSync(`rm -rf "${claimFile}"`, { cwd: process.cwd() });
        } catch (e) {
          // Ignore if doesn't exist
        }
        
        execSync(`npx cdk8s import ${crdPath} --output ${claimFile}`, {
          stdio: 'inherit',
          cwd: process.cwd(),
        });
        
        // Flatten the directory structure
        try {
          const importDir = `imports/${importName}-claim.ts`;
          const files = readdirSync(importDir);
          if (files.length > 0) {
            const srcFile = `${importDir}/${files[0]}`;
            const destFile = `imports/${importName}-claim.ts`;
            const fileContent = readFileSync(srcFile, 'utf-8');
            execSync(`rm -rf "${importDir}"`);
            writeFileSync(destFile, fileContent);
          }
        } catch (e) {
          // Already a file, not a directory
        }
        
        claimImports.push(importName);
      }
    } catch (e) {
      // Skip documents that fail to parse
      continue;
    }
  }
}

// Step 3: Update imports/index.ts to include all claims
console.log('📝 Updating imports/index.ts...');
const indexPath = 'imports/index.ts';
let indexContent = readFileSync(indexPath, 'utf-8');

// Remove old claim exports
indexContent = indexContent.replace(/\n\/\/ Nebula Claims[\s\S]*$/, '');

// Add new claim exports
const claimExports = claimImports.map(name => `export * from './${name}-claim';`).join('\n');
indexContent += `\n// Nebula Claims (auto-generated from XRDs)\n${claimExports}\n`;

writeFileSync(indexPath, indexContent);

console.log('✅ Done! Generated typed claim classes:');
claimImports.forEach(name => console.log(`   - ${name}-claim.ts`));
