import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerResources } from "./support/ecr-reader/config";
import { spawnSync } from "node:child_process";

for (const scenario of ["success", "sts-failure", "ecr-failure", "malformed"]) {
  test(`explicit token exchange: ${scenario}`, () => {
    const work = mkdtempSync(join(tmpdir(), "ecr-token-test-"));
    try {
      writeFileSync(join(work, "aws"), `#!/bin/sh
set -eu
case "$1:$2" in
  sts:assume-role-with-web-identity)
    printf '%s\\n' "$@" > "$REGISTRY_TOKEN_WORK_DIR/arguments"
    if [ "$SCENARIO" = sts-failure ]; then echo synthetic-sensitive-jwt >&2; exit 1; fi
    if [ "$SCENARIO" = malformed ]; then printf 'too few\\n'; exit 0; fi
    printf 'fixture-access\\tfixture-secret\\tfixture-session\\n' ;;
  ecr:get-authorization-token)
    test "$AWS_ACCESS_KEY_ID" = fixture-access
    test "$AWS_SECRET_ACCESS_KEY" = fixture-secret
    test "$AWS_SESSION_TOKEN" = fixture-session
    if [ "$SCENARIO" = ecr-failure ]; then echo fixture-secret >&2; exit 1; fi
    printf '%s\\n' '{"authorizationData":[]}' ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
      const script = readerResources().find(resource => resource.kind === "ConfigMap")!.data["token.sh"];
      writeFileSync(join(work, "token.sh"), script);
      const result = spawnSync("/bin/sh", [join(work, "token.sh")], {
        env: { ...process.env, PATH: `${work}:${process.env.PATH}`, REGISTRY_TOKEN_WORK_DIR: work, SCENARIO: scenario,
          READER_ROLE_ARN: "arn:aws:iam::123456789012:role/reader", READER_TOKEN_FILE: "/projected/token" },
        encoding: "utf8", timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status === 0, scenario === "success");
      assert.ok(!existsSync(join(work, "sts.tsv")));
      assert.ok(!existsSync(join(work, "aws-error")));
      const args = readFileSync(join(work, "arguments"), "utf8");
      assert.match(args, /--web-identity-token\nfile:\/\/\/projected\/token/);
      assert.match(args, /--no-sign-request/);
      assert.match(args, /--duration-seconds\n900/);
      for (const secret of ["synthetic-sensitive-jwt", "fixture-access", "fixture-secret", "fixture-session"])
        assert.ok(!(result.stdout + result.stderr + args).includes(secret));
      if (scenario === "success") assert.deepEqual(JSON.parse(readFileSync(join(work, "ecr.json"), "utf8")), { authorizationData: [] });
    } finally { rmSync(work, { recursive: true }); }
  });
}
