import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { manualSession } from "../src/loader/manual";
import { retryableSdkLoader } from "../src/loader/main";

const hardware = { measurement: "a".repeat(96), minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } };
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, "timed out waiting for manual session"); await new Promise(resolve => setTimeout(resolve, 2)); }
}
class Element {
  hidden = false; disabled = false; checked = false; required = false; value = ""; textContent = "";
  files: { size: number; text(): Promise<string> }[] = [];
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  button?: Element;
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  querySelector() { return this.button; }
  submit() { for (const listener of this.listeners.get("submit") ?? []) listener({ preventDefault() {} }); }
  change() { for (const listener of this.listeners.get("change") ?? []) listener({ preventDefault() {}, target: this } as any); }
}
function fixture(t: TestContext) {
  const elements = new Map<string, Element>();
  const get = (name: string) => { if (!elements.has(name)) elements.set(name, new Element()); return elements.get(name)!; };
  get("manual-owner").hidden = true; get("manual-verification").button = new Element();
  const values = new Map<string, string>(); let storageReads = 0, storageWrites = 0;
  const network: string[] = [], der = new Uint8Array([0x30, 0x01, 0x00]);
  const record = { version: 1, certificateDer: Buffer.from(der).toString("base64"),
    certificateSha256: createHash("sha256").update(der).digest("hex"), publicKeySha256: "b".repeat(64) };
  for (const [name, value] of Object.entries({ document: { getElementById: get },
    localStorage: { getItem: (key: string) => { storageReads++; return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { storageWrites++; values.set(key, value); } },
    fetch: async (input: string, init: RequestInit) => {
      network.push(input); assert.equal(input, "/nebula/v1/tls"); assert.equal(init.credentials, "omit");
      assert.equal(init.method ?? "GET", "GET"); assert.equal(init.body, undefined); return Response.json(record);
    } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  return { get, values, network, storageReads: () => storageReads, storageWrites: () => storageWrites };
}

test("failed SDK initialization is singleflight, retryable, and successful initialization stays cached", async () => {
  let calls = 0, fail!: (error: Error) => void;
  const sdk = { fetch() {} };
  const load = retryableSdkLoader(() => ++calls === 1 ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve(sdk));
  const first = load(), concurrent = load(); assert.equal(first, concurrent);
  await until(() => calls === 1); fail(new Error("test initialization failed"));
  await assert.rejects(first, /initialization failed/);
  const retry = load(); assert.equal(await retry, sdk); assert.equal(await load(), sdk); assert.equal(load(), retry); assert.equal(calls, 2);
});

test("SDK failure keeps the verification gate usable and never reads or changes owner state", async t => {
  const f = fixture(t); const vaultKey = "nebula-confidential-vault-v1:https://guest.example";
  f.values.set(vaultKey, "unchanged encrypted recovery fixture");
  f.get("claim-token").value = "c".repeat(64); f.get("vault-password").value = "test-only-owner-password";
  let recoveryReads = 0, sdkCalls = 0;
  f.get("manual-recovery").files = [{ size: 64, text: async () => { recoveryReads++; return "not opened"; } }];
  const generate = t.mock.method(crypto.subtle, "generateKey"); const imports = t.mock.method(crypto.subtle, "importKey");
  void manualSession("https://guest.example", async () => { sdkCalls++; throw new Error("SDK unavailable"); }, hardware);
  await until(() => f.get("manual-verification").listeners.has("submit"));
  f.get("independently-verified").checked = true; f.get("manual-verification").submit();
  await until(() => f.get("loader-status").textContent.includes("reload this page"));
  assert.equal(f.get("manual-owner").hidden, true); assert.equal(f.get("manual-verification").hidden, false);
  assert.equal(f.get("manual-verification").button!.disabled, false);
  assert.equal(f.get("claim-token").value, "c".repeat(64)); assert.equal(f.get("vault-password").value, "test-only-owner-password");
  assert.equal(f.storageReads(), 0); assert.equal(f.storageWrites(), 0); assert.equal(recoveryReads, 0);
  assert.equal(generate.mock.callCount(), 0); assert.equal(imports.mock.callCount(), 0);
  assert.equal(f.values.get(vaultKey), "unchanged encrypted recovery fixture"); assert.deepEqual(f.network, ["/nebula/v1/tls"]);
  f.get("manual-verification").submit(); await until(() => sdkCalls === 2);
});

test("SDK preflight deduplicates approval and only one owner can resolve after a successful retry", async t => {
  const f = fixture(t); let initialize = 0, permit!: () => void;
  const load = retryableSdkLoader(() => ++initialize === 1 ? Promise.reject(new Error("first attempt")) :
    new Promise(resolve => { permit = () => resolve({}); }));
  const generate = t.mock.method(crypto.subtle, "generateKey");
  const session = manualSession("https://guest.example", load, hardware);
  await until(() => f.get("manual-verification").listeners.has("submit"));
  f.get("manual-verification").submit(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(initialize, 0);
  f.get("independently-verified").checked = true; f.get("manual-verification").submit();
  await until(() => f.get("loader-status").textContent.includes("reload this page"));
  f.get("manual-verification").submit(); f.get("manual-verification").submit();
  await until(() => initialize === 2); assert.equal(f.get("manual-owner").hidden, true); permit();
  await until(() => !f.get("manual-owner").hidden); assert.equal(generate.mock.callCount(), 0);
  f.get("claim-token").value = "d".repeat(64); f.get("vault-password").value = "test-only-owner-password";
  f.get("manual-owner").submit(); f.get("manual-owner").submit(); const result = await session;
  const owners = generate.mock.calls.filter(call => (call.arguments[0] as Algorithm).name === "ECDSA");
  assert.equal(owners.length, 1); assert.equal(result.owner.token, "d".repeat(64));
  f.get("manual-owner").submit(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(generate.mock.calls.filter(call => (call.arguments[0] as Algorithm).name === "ECDSA").length, 1);
  assert.equal(initialize, 2); assert.equal(f.storageWrites(), 0); assert.deepEqual(f.network, ["/nebula/v1/tls"]);
});

test("returning owners can select a recovery file without entering a used invitation", async t => {
  const f = fixture(t);
  void manualSession("https://guest.example", async () => ({}), hardware);
  await until(() => f.get("manual-verification").listeners.has("submit"));
  f.get("independently-verified").checked = true; f.get("manual-verification").submit();
  await until(() => !f.get("manual-owner").hidden);
  assert.equal(f.get("claim-token").required, true);
  assert.match(f.get("owner-access-guidance").textContent, /no saved owner access.*recovery file/i);
  f.get("manual-recovery").files = [{ size: 1, text: async () => "" }];
  f.get("manual-recovery").change();
  assert.equal(f.get("claim-token").required, false);
  assert.match(f.get("owner-access-guidance").textContent, /Recovery file selected/);
  f.get("manual-recovery").files = []; f.get("manual-recovery").change();
  assert.equal(f.get("claim-token").required, true);
});

test("saved owner access asks only for the existing password", async t => {
  const f = fixture(t);
  f.values.set("nebula-confidential-vault-v1:https://guest.example", "encrypted owner fixture");
  void manualSession("https://guest.example", async () => ({}), hardware);
  await until(() => f.get("manual-verification").listeners.has("submit"));
  f.get("independently-verified").checked = true; f.get("manual-verification").submit();
  await until(() => !f.get("manual-owner").hidden);
  assert.equal(f.get("claim-token").required, false);
  assert.match(f.get("owner-access-guidance").textContent, /Saved owner access found.*no token/i);
});
