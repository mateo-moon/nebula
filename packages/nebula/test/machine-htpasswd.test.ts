import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { machineHtpasswd } from "../src/utils/htpasswd";

const password = "synthetic-machine-password-".repeat(2);
const existing = "$2y$12$" + "a".repeat(53);
const context = "metrics.example.test";
const verifiable = (hash: string) => hash.replace("$2y$", "$2b$");
const hashOf = (content: string) => content.trim().split(":")[1]!;
const saltOf = (hash: string) => hash.slice(7, 29);

test("held passwords are hashed cheaply and identically on every render; unheld accounts keep their hash", () => {
  const accounts = [{ username: "fleet", password }, { username: "external", hash: existing }];
  const content = machineHtpasswd(accounts, { context });
  assert.equal(content, machineHtpasswd(accounts, { context }));
  const [fleet, external, rest] = content.split("\n");
  assert.equal(rest, "");
  assert.match(fleet!, /^fleet:\$2y\$05\$[./A-Za-z0-9]{53}$/);
  assert.equal(external, `external:${existing}`);
  const hash = fleet!.slice("fleet:".length);
  assert.equal(bcrypt.compareSync(password, verifiable(hash)), true);
  assert.equal(bcrypt.compareSync(`${password}x`, verifiable(hash)), false);
  assert.match(machineHtpasswd([{ username: "fleet", password }], { context, cost: 4 }), /^fleet:\$2y\$04\$/);
});

test("the salt says nothing about the password", () => {
  const first = hashOf(machineHtpasswd([{ username: "fleet", password }], { context }));
  const rotated = hashOf(machineHtpasswd([{ username: "fleet", password: `${password}-rotated` }], { context }));
  assert.equal(saltOf(rotated), saltOf(first), "a different password must not move the salt");
  assert.notEqual(rotated, first);
  const other = hashOf(machineHtpasswd([{ username: "other", password }], { context }));
  const elsewhere = hashOf(machineHtpasswd([{ username: "fleet", password }], { context: "logs.example.test" }));
  assert.notEqual(saltOf(other), saltOf(first), "another account gets another salt");
  assert.notEqual(saltOf(elsewhere), saltOf(first), "the same account elsewhere gets another salt");
  const stored = hashOf(machineHtpasswd([{ username: "fleet", password, salt: "abcdefghijklmnopqrstuu" }], { context }));
  assert.equal(saltOf(stored), "abcdefghijklmnopqrstuu");
  assert.equal(bcrypt.compareSync(password, verifiable(stored)), true);
});

test("guessable passwords, malformed accounts, salts and costs are refused", () => {
  const refuse = (accounts: Parameters<typeof machineHtpasswd>[0], pattern: RegExp, cost?: number) =>
    assert.throws(() => machineHtpasswd(accounts, { context, cost }), pattern);
  refuse([{ username: "fleet", password: "short-password" }], /at least 20 characters/);
  refuse([{ username: "fleet", password: `${password}\nfleet2:x` }], /random password/);
  refuse([{ username: "a:b", password }], /Invalid or duplicate/);
  refuse([{ username: "fleet", password }, { username: "fleet", hash: existing }], /Invalid or duplicate/);
  refuse([{ username: "external", hash: "$apr1$notbcrypt" }], /bcrypt hash/);
  refuse([{ username: "fleet", password, salt: "too-short" }], /22-character/);
  refuse([{ username: "fleet", password }], /cost/, 3);
  assert.throws(() => machineHtpasswd([{ username: "fleet", password }], { context: "" }), /context/);
});
