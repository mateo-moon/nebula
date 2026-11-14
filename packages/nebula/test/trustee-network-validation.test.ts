import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateNetwork } from "../src/modules/k8s/trustee/genpolicy";

const accepted = [
  "^10[.]44[.][0-9]{1,3}[.][0-9]{1,3}$", "^(?:fd00|2001:db8):[0-9a-f:]+$",
  "^[a-fA-F0-9:]{2,64}$", "^192\\.0\\.2\\.\\d{1,3}$", "^(10|192)[.][0-9.]+$", "^[^f:][0-9a-f:]*$",
];
const rejected = [
  "^[]$", "^[^]$", "^[[:digit:]]+$", "^[a-\\d]+$", "^[\\d-a]+$", "^[a-b-c]+$",
  "^10|192$", "^a{1001}$", "^a{2,1}$", "^a{01}$", "^a{,3}$", "^a(?=b)$", "^a(?P<x>b)$",
  "^(a)\\1$", "^\\u0031$", "^a\\$", "^a[]b$", "^a(?i)b$",
];
const check = (pattern: string) => validateNetwork({ ipv4AddressPattern: pattern, ipv6AddressPattern: "^[0-9a-f:]+$" });

test("CNI validation rejects JS/RE2 grammar ambiguities before native publication", () => {
  for (const pattern of accepted) assert.doesNotThrow(() => check(pattern), pattern);
  for (const pattern of rejected) assert.throws(() => check(pattern), /RE2 subset/, pattern);
});

const go = spawnSync("go", ["version"], { timeout: 15000, stdio: "ignore" }).status === 0;
test("accepted CNI syntax compiles in real Go RE2 and agrees on literal IP addresses", { skip: !go, timeout: 60000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-network-regex-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "main.go"), `package main
import("encoding/json";"os";"regexp")
func main(){ var in struct{Patterns []string; Addresses []string}; if err:=json.NewDecoder(os.Stdin).Decode(&in);err!=nil{panic(err)}; out:=[][]bool{}; for _,pattern:=range in.Patterns{re,err:=regexp.Compile(pattern);if err!=nil{panic(err)}; row:=[]bool{};for _,address:=range in.Addresses{row=append(row,re.MatchString(address))};out=append(out,row)};json.NewEncoder(os.Stdout).Encode(out) }
`);
  const addresses = ["10.44.0.1", "10.44.255.254", "192.0.2.1", "192.0.2.255", "fd00::1", "2001:db8::f", "FE80::1", "203.0.113.4"];
  const actual = JSON.parse(execFileSync("go", ["run", "main.go"], { cwd: directory, timeout: 45000,
    env: { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off", GO111MODULE: "off" },
    input: JSON.stringify({ Patterns: accepted, Addresses: addresses }), encoding: "utf8" }));
  assert.deepEqual(actual, accepted.map(pattern => addresses.map(address => new RegExp(pattern).test(address))));
});
