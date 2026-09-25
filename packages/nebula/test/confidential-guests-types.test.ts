import assert from "node:assert/strict";
import test from "node:test";
import { digestImage, isDigestImage } from "../src/modules/k8s/confidential-guests";

const HEX = "0123456789abcdef".repeat(4);

test("digestImage accepts fully qualified repo@sha256 references and returns them unchanged", () => {
  const valid = [
    `ghcr.io/example/app@sha256:${HEX}`,
    `registry.example.com:5000/team/app-name/sub_component@sha256:${HEX}`,
    `localhost:5000/app@sha256:${HEX}`,
    `localhost/app@sha256:${HEX}`,
    `docker.io/library/alpine@sha256:${HEX}`,
    `[::1]:5000/app@sha256:${HEX}`,
    `registry.example.com/a.b/c__d/e---f@sha256:${HEX}`,
  ];
  for (const ref of valid) {
    const image = digestImage(ref);
    assert.equal(image, ref, "a digest image is returned byte-for-byte");
    assert.ok(isDigestImage(ref), ref);
  }
});

// containerd normalizes Docker Hub references (distribution/reference):
// index.docker.io becomes docker.io and a one-component docker.io name gains
// library/. A policy bound to the unnormalized string would not match what
// the runtime reports, so only the normalized spelling is accepted.
test("digestImage rejects tags, short or foreign digests and anything a runtime would rewrite", () => {
  const invalid: unknown[] = [
    "",
    "ghcr.io/example/app",
    "ghcr.io/example/app:1.0",
    `ghcr.io/example/app:1.0@sha256:${HEX}`,
    `ghcr.io/example/app@sha256:${HEX.slice(1)}`,
    `ghcr.io/example/app@sha256:${HEX}0`,
    `ghcr.io/example/app@sha256:${HEX.toUpperCase()}`,
    `ghcr.io/example/app@sha512:${HEX}${HEX}`,
    `example/app@sha256:${HEX}`,
    `app@sha256:${HEX}`,
    `ghcr.io/Example/app@sha256:${HEX}`,
    `ghcr.io/example/app@sha256:${HEX}\n`,
    ` ghcr.io/example/app@sha256:${HEX}`,
    `docker://ghcr.io/example/app@sha256:${HEX}`,
    `ghcr.io/example//app@sha256:${HEX}`,
    `ghcr.io/example/app-@sha256:${HEX}`,
    `ghcr.io/${"a".repeat(256)}@sha256:${HEX}`,
    `-registry.example.com/app@sha256:${HEX}`,
    `docker.io/alpine@sha256:${HEX}`,
    `index.docker.io/library/alpine@sha256:${HEX}`,
    `registry-1.docker.io/library/alpine@sha256:${HEX}`,
    `Docker.io/library/alpine@sha256:${HEX}`,
    `docker.io:443/library/alpine@sha256:${HEX}`,
    123,
    null,
    undefined,
  ];
  for (const ref of invalid) {
    assert.throws(() => digestImage(ref as string), TypeError, String(ref));
    assert.equal(isDigestImage(ref), false, String(ref));
  }
});

test("digestImage explains why a reference was refused", () => {
  assert.throws(() => digestImage("ghcr.io/example/app:1.0"), /repo@sha256:<64 lowercase hex>/);
  assert.throws(() => digestImage(`example/app@sha256:${HEX}`), /registry host/);
  assert.throws(() => digestImage(`docker.io/alpine@sha256:${HEX}`), /docker\.io\/library\/alpine/);
  assert.throws(() => digestImage(`index.docker.io/library/alpine@sha256:${HEX}`), /docker\.io/);
});
