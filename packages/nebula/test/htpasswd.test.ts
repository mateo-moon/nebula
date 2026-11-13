import assert from "node:assert/strict";
import test from "node:test";
import { bcryptUsers } from "../src/utils/htpasswd";

const bcryptHash = "$2y$10$abcdefghijklmnopqrstuu" + "a".repeat(31);
const prototypeUsernames = ["constructor", "toString", "__proto__", "hasOwnProperty"];

test("bcrypt parsing preserves hashes and refuses ambiguous or unauthenticated maps", () => {
  assert.deepEqual({ ...bcryptUsers(`# existing\nreader:${bcryptHash}:comment\n`) }, { reader: bcryptHash });
  for (const value of ["", "reader:plaintext", `reader:${bcryptHash}\nreader:${bcryptHash}`, `reader:${bcryptHash.slice(0, -1)}`])
    assert.throws(() => bcryptUsers(value), /bcrypt|nonempty/);
});

test("bcrypt account lookups return undefined for unconfigured prototype names", () => {
  const users = bcryptUsers(`reader:${bcryptHash}`);
  for (const username of prototypeUsernames)
    assert.equal(users[username], undefined, `${username} must not appear as a configured account`);
});

test("bcrypt accepts explicit prototype-named accounts and rejects their duplicates", () => {
  for (const username of prototypeUsernames) {
    const account = `${username}:${bcryptHash}`;
    const users = bcryptUsers(account);
    assert.ok(Object.hasOwn(users, username));
    assert.equal(users[username], bcryptHash);
    assert.deepEqual(JSON.parse(JSON.stringify(users)), { [username]: bcryptHash });
    assert.throws(() => bcryptUsers(`${account}\n${account}`), /duplicate bcrypt/);
  }
});
