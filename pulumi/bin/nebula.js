#!/usr/bin/env -S node --import=tsx/esm
// Generated thin wrapper that runs the tsx ESM loader to execute TS directly.
// Resolve local nebula.config.(ts|js|mjs) and pass through argv unchanged.
process.env.NEBULA_CLI = '1';
import('../src/cli.ts').then(m => m.runCli(process.argv)).catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});


