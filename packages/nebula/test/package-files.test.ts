// The package ships its license and notice. Consumers install it from a git
// subpath or a tarball that holds only the package.json `files`, so the
// copies in packages/nebula must match the repository root files.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { license: string; files: string[] };

test("the package declares Apache-2.0 and ships LICENSE and NOTICE identical to the repository root", () => {
  assert.equal(manifest.license, "Apache-2.0");
  assert.match(readFileSync(join(repoRoot, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
  for (const name of ["LICENSE", "NOTICE"]) {
    assert.ok(manifest.files.includes(name), `${name} is not listed in files`);
    assert.ok(existsSync(join(pkgDir, name)), `packages/nebula/${name} is missing`);
    assert.ok(readFileSync(join(pkgDir, name)).equals(readFileSync(join(repoRoot, name))), `packages/nebula/${name} differs from the root copy`);
  }
});

test("every files entry exists", () => {
  for (const entry of manifest.files) {
    if (/[*?[]/.test(entry)) continue;
    assert.ok(existsSync(join(pkgDir, entry)), `files lists ${entry}, which does not exist`);
  }
});
