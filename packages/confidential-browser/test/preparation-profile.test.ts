import assert from "node:assert/strict";
import { test } from "node:test";
import profiles from "../src/loader/profiles.json";
import { preparationCandidates } from "../src/loader/profile-selection";
import { AttestedChannel, type AttestedFetch, type VerifiedResponse } from "../src/loader/transport";
import { newOwner } from "../src/loader/owner";
import { validatePreparationClaim } from "../src/loader/claim";

const current = profiles.profiles[0], legacy = profiles.profiles[1], pin = "a".repeat(64);
const response = (status = 200) => Object.assign(new Response("{}", { status }), {
  attest_info: { server_public_key: pin, attestation_result: "software-only SDK fixture" },
}) as VerifiedResponse;

test("new and unpinned owners cannot select an older preparation release", async () => {
  assert.ok(profiles.profiles.length > 1, "the regression must retain legacy recovery releases");
  for (const saved of [undefined, { preparationPin: undefined }, await newOwner(), { preparationPin: undefined, restored: true },
    { preparationPin: undefined, claimed: true, profile: legacy.id, connection: { preparationPin: pin } }]) {
    assert.deepEqual(preparationCandidates(profiles.profiles, saved), [current]);
  }
  for (const preparationPin of ["", null, false, 0, "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    assert.throws(() => preparationCandidates(profiles.profiles, { preparationPin } as any), /Invalid saved/);
  }
  assert.throws(() => preparationCandidates([]), /No current reviewed/);
});

test("routing a new owner to an approved legacy VM cannot reach its UI or send an owner proof", async () => {
  const owner = await newOwner(); owner.token = "b".repeat(64);
  let calls = 0;
  const fetcher: AttestedFetch = async (url, init, config: any) => {
    calls++;
    assert.equal(new URL(url).pathname, "/nebula/v1/browser");
    assert.equal((init.headers as any)?.Authorization, undefined);
    assert.equal(config.ohttp.expected_server_public_key, undefined);
    const policy = Buffer.from(config.verify.attestation_policy.content, "base64").toString();
    if (policy.includes(current.identity.initDataSha256)) throw new Error("Legacy workload is not the current preparation release");
    assert.fail("A new owner attempted a legacy policy fallback");
  };
  for (const profile of preparationCandidates(profiles.profiles, owner)) {
    const channel = new AttestedChannel(fetcher, "https://routed.example/", profile.identity);
    await assert.rejects(channel.request("/nebula/v1/browser"), /not the current/);
  }
  assert.equal(calls, 1);
  assert.equal(owner.preparationPin, undefined);
});

test("legacy recovery preserves the saved channel pin and still needs its original owner", async () => {
  const owner = await newOwner(); owner.preparationPin = pin;
  assert.deepEqual(preparationCandidates(profiles.profiles, owner), profiles.profiles);
  assert.equal(owner.preparationPin, pin);
  const profile = preparationCandidates(profiles.profiles, owner).find(profile => profile.id === legacy.id)!;
  let ownerRequests = 0, authorized = false;
  const channel = new AttestedChannel(async (url, init, config: any) => {
    assert.equal(config.ohttp.expected_server_public_key, pin);
    const policy = Buffer.from(config.verify.attestation_policy.content, "base64").toString();
    assert.ok(policy.includes(legacy.identity.initDataSha256));
    if (new URL(url).pathname === "/nebula/v1/job") {
      ownerRequests++;
      assert.match((init.headers as Record<string, string>).Authorization, /^Bearer /);
      return response(authorized ? 200 : 403);
    }
    return response();
  }, "https://existing.example/", profile.identity, owner.preparationPin);
  await channel.request("/nebula/v1/browser");
  await assert.rejects(validatePreparationClaim(channel, owner, { claimed: true }), /another owner/);
  assert.equal(ownerRequests, 1);
  authorized = true;
  await validatePreparationClaim(channel, owner, { claimed: true });
  assert.equal(ownerRequests, 2);
  assert.equal(owner.preparationPin, pin);
  const replacement = new AttestedChannel(async () => Object.assign(response(), {
    attest_info: { server_public_key: "c".repeat(64), attestation_result: "software-only replacement" },
  }), "https://existing.example/", profile.identity, owner.preparationPin);
  await assert.rejects(replacement.request("/nebula/v1/browser"), /changed/);
  assert.equal(owner.preparationPin, pin);
});
