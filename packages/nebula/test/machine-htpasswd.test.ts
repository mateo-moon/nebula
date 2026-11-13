import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { machineHtpasswd } from "../src/utils/htpasswd";

const password = "synthetic-machine-password-".repeat(2);
const existing = "$2y$12$" + "a".repeat(53);
const verifiable = (hash: string) => hash.replace("$2y$", "$2b$");

test("held passwords are hashed cheaply and identically on every render; unheld accounts keep their hash", () => {
  const accounts = [{ username: "fleet", password }, { username: "external", hash: existing }];
  const content = machineHtpasswd(accounts);
  assert.equal(content, machineHtpasswd(accounts));
  const [fleet, external, rest] = content.split("\n");
  assert.equal(rest, "");
  assert.match(fleet!, /^fleet:\$2y\$05\$[./A-Za-z0-9]{53}$/);
  assert.equal(external, `external:${existing}`);
  const hash = fleet!.slice("fleet:".length);
  assert.equal(bcrypt.compareSync(password, verifiable(hash)), true);
  assert.equal(bcrypt.compareSync(`${password}x`, verifiable(hash)), false);
  assert.notEqual(machineHtpasswd([{ username: "other", password }]), `other:${hash}\n`);
  assert.match(machineHtpasswd([{ username: "fleet", password }], 4), /^fleet:\$2y\$04\$/);
});

test("guessable passwords, malformed accounts and bad costs are refused", () => {
  assert.throws(() => machineHtpasswd([{ username: "fleet", password: "short-password" }]), /at least 20 characters/);
  assert.throws(() => machineHtpasswd([{ username: "fleet", password: `${password}\nfleet2:x` }]), /random password/);
  assert.throws(() => machineHtpasswd([{ username: "a:b", password }]), /Invalid or duplicate/);
  assert.throws(() => machineHtpasswd([{ username: "fleet", password }, { username: "fleet", hash: existing }]), /Invalid or duplicate/);
  assert.throws(() => machineHtpasswd([{ username: "external", hash: "$apr1$notbcrypt" }]), /bcrypt hash/);
  assert.throws(() => machineHtpasswd([{ username: "fleet", password }], 3), /cost/);
});
