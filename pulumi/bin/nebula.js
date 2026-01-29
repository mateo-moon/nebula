#!/usr/bin/env -S node --import=tsx/esm
// Nebula CLI entry point - runs the CLI via tsx ESM loader
process.env.NEBULA_CLI = '1';
import('../src/cli.ts');
