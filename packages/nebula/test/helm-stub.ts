import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Yaml } from "cdk8s";

/** Run with a `helm` that renders nothing and records each release's values. */
export function withStubHelm<T>(run: (valuesOf: (release: string) => any) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "nebula-helm-stub-"));
  writeFileSync(join(dir, "helm"), [
    "#!/bin/sh",
    "values= release= last=",
    'for arg in "$@"; do',
    '  [ "$last" = -f ] && values=$arg',
    "  release=$last last=$arg",
    "done",
    '[ -z "$values" ] || cp "$values" "$HELM_STUB_OUT/$release.yaml"',
    "",
  ].join("\n"), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HELM_STUB_OUT: process.env.HELM_STUB_OUT };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.HELM_STUB_OUT = dir;
  try {
    return run(release => Yaml.load(join(dir, `${release}.yaml`))[0]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
