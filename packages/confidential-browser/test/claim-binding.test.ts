import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePreparationClaim } from "../src/loader/claim";
import { newOwner } from "../src/loader/owner";
import { hash, type VerifiedResponse } from "../src/loader/transport";

test("an unused invitation is checked before a new preparation pin can be persisted", async () => {
  const owner = await newOwner(); owner.token = "a".repeat(64);
  const channel = { request: async () => { assert.fail("An unused token never authorizes an owner request"); } };
  await assert.rejects(validatePreparationClaim(channel, owner, { claimed: false, claimSha256: "0".repeat(64) }), /invitation does not match/);
  assert.equal(owner.preparationPin, undefined);
  await validatePreparationClaim(channel, owner, { claimed: false, claimSha256: await hash(new Uint8Array(32).fill(0xaa)) });
  assert.equal(owner.preparationPin, undefined, "Only the loader commits the pin after successful claim validation");
});
test("a previously claimed preparation instance must authenticate the actual stored owner", async () => {
  const owner = await newOwner(); let authorization = "";
  const channel = { request: async (_path: string, init?: RequestInit) => { authorization = (init!.headers as Record<string,string>).Authorization; return Object.assign(new Response("{}", { status: 403 }), { attest_info: { server_public_key: "b".repeat(64), attestation_result: "test-only verifier result" } }) as VerifiedResponse; } };
  await assert.rejects(validatePreparationClaim(channel, owner, { claimed: true }), /another owner/);
  assert.match(authorization, /^Bearer /);
  assert.equal(owner.preparationPin, undefined);
});
