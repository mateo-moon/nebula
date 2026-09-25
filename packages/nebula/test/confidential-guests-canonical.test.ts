import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../src/modules/k8s/confidential-guests";

// Inputs and the exact bytes the existing canonical-JSON implementation used
// by consumers produces for them (sorted keys by UTF-16 code units, no
// whitespace, JSON.stringify escaping and number formatting).
const INPUTS: unknown[] = [
  null, true, false, 0, -0, 1, -1, 0.1, 1e21, 1e-7, 123456.789, Number.MAX_SAFE_INTEGER,
  "", "plain", "quote\" backslash\\ slash/", "ctl\u0000\u0001\u001f\t\n\r", "unicode é ü 雪 \u2028\u2029", "astral \ud83d\ude00", "lone \ud800 surrogate",
  [], {}, [[]], [{}], [1, "1", [true, null]],
  { b: 1, a: 2, c: 3 },
  { B: 1, a: 2, "": 3, _: 4, "10": 5, "9": 6, "1a": 7 },
  { "\ufb01": 1, "\ud83d\ude00": 2, "é": 3, "z": 4 },
  { nested: { z: [3, 2, 1], a: { y: null, x: false } }, list: [{ b: 2, a: 1 }, { d: 4, c: 3 }] },
  {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: "guest-0", namespace: "guests", labels: { "app.example.com/role": "guest" }, annotations: { "example.com/config-sha256": "0".repeat(64) } },
    spec: {
      runtimeClassName: "kata-qemu-snp",
      containers: [{ name: "main", image: "ghcr.io/example/app@sha256:" + "ab".repeat(32), args: ["--flag", "value with spaces"], env: [{ name: "B", value: "2" }, { name: "A", value: "1" }], resources: { limits: { cpu: "2", memory: "4Gi" } } }],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-0" } }],
    },
  },
];

const EXPECTED: [string, string][] = [
  ["null", "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
  ["true", "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"],
  ["false", "fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa"],
  ["0", "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
  ["0", "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
  ["1", "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b"],
  ["-1", "1bad6b8cf97131fceab8543e81f7757195fbb1d36b376ee994ad1cf17699c464"],
  ["0.1", "14be4b45f18e0d8c67b4f719b5144eee88497e413709d11d85b096d8e2346310"],
  ["1e+21", "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c"],
  ["1e-7", "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"],
  ["123456.789", "df16e278bec8bd79b90a36552e05a4179549b0870da68fbe2580a8a920597ef4"],
  ["9007199254740991", "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"],
  ["\"\"", "12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126"],
  ["\"plain\"", "945603a8f587786b463c3f94fce115c0fae88fac2728cc96ddf5981cf7f61741"],
  ["\"quote\\\" backslash\\\\ slash/\"", "8dd8856d094d9e41a818b06e536106dfc0f9cdd0d1e7fd9034157fdc492f531f"],
  ["\"ctl\\u0000\\u0001\\u001f\\t\\n\\r\"", "6004bc6c5fac685dce4eaf1b08d381379998af4f54568c0a05cd78b7b2074b7a"],
  ["\"unicode \u00e9 \u00fc \u96ea \u2028\u2029\"", "f75e5f768e498239f8ebadd43464990f1963eb78f3950e2a849d901714b8c269"],
  ["\"astral \ud83d\ude00\"", "997a7d93be54010fe7dc54ebf7242e87fb30f2654a22110711847f9107b30fd0"],
  ["\"lone \\ud800 surrogate\"", "c737bd39aea523a5f255bb880d8624805739a48bddc37397b2928dce9147b132"],
  ["[]", "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  ["{}", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  ["[[]]", "cf1cbb66a638b4860a516671fb74850e6ccf787fe6c4c8d29e9c04efe880bd05"],
  ["[{}]", "e10808d43975dc400731053386849f864f297e6c4f7519c380f3dbaf7067a840"],
  ["[1,\"1\",[true,null]]", "9e04206bc113e507b7d535850f6f852a0a3a3315f8fe6345a26f4a66aaa911bb"],
  ["{\"a\":2,\"b\":1,\"c\":3}", "e145110e712e3ed0a6b233551b27a90aa39b4c93ed67e111ba2002d16e5ed1fa"],
  ["{\"\":3,\"10\":5,\"1a\":7,\"9\":6,\"B\":1,\"_\":4,\"a\":2}", "3008be457ba013b240d3d3ee1617a528c52972014bb5d0630cf45da461ac24d8"],
  ["{\"z\":4,\"\u00e9\":3,\"\ud83d\ude00\":2,\"\ufb01\":1}", "cb6d99f11a1a44e3300bce4b4865f20c76dcf64fa252976e73bcd1cb8f9698b9"],
  ["{\"list\":[{\"a\":1,\"b\":2},{\"c\":3,\"d\":4}],\"nested\":{\"a\":{\"x\":false,\"y\":null},\"z\":[3,2,1]}}", "ea0da557597f70b38813cb61aba861973d1e51d578b6c03355d6d65cd431085b"],
  ["{\"apiVersion\":\"v1\",\"kind\":\"Pod\",\"metadata\":{\"annotations\":{\"example.com/config-sha256\":\"0000000000000000000000000000000000000000000000000000000000000000\"},\"labels\":{\"app.example.com/role\":\"guest\"},\"name\":\"guest-0\",\"namespace\":\"guests\"},\"spec\":{\"containers\":[{\"args\":[\"--flag\",\"value with spaces\"],\"env\":[{\"name\":\"B\",\"value\":\"2\"},{\"name\":\"A\",\"value\":\"1\"}],\"image\":\"ghcr.io/example/app@sha256:abababababababababababababababababababababababababababababababab\",\"name\":\"main\",\"resources\":{\"limits\":{\"cpu\":\"2\",\"memory\":\"4Gi\"}}}],\"runtimeClassName\":\"kata-qemu-snp\",\"volumes\":[{\"name\":\"data\",\"persistentVolumeClaim\":{\"claimName\":\"data-0\"}}]}}", "8ec05ce330e3c8902fcab04b9a0ef62ae5a8745b5ae6971291933703b314baf7"],
];

// The consumer-side implementation, kept verbatim as the differential oracle.
const reference = (v: any): string => Array.isArray(v) ? `[${v.map(reference).join(",")}]` :
  v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${reference(v[k])}`).join(",")}}` : JSON.stringify(v);

test("canonicalJson vectors are byte-equal to the consumer implementation", () => {
  assert.equal(INPUTS.length, EXPECTED.length);
  INPUTS.forEach((input, i) => {
    const [canonical, digest] = EXPECTED[i];
    assert.equal(canonicalJson(input), canonical, `vector ${i}`);
    assert.equal(sha256Hex(canonicalJson(input)), digest, `vector ${i} digest`);
    assert.equal(reference(input), canonical, `oracle drifted at vector ${i}`);
  });
});

// Deterministic PRNG so failures reproduce.
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(rand: () => number, depth: number): unknown {
  const alphabet = ["a", "B", "0", "_", "-", "é", "雪", "\ud83d\ude00", "\u0000", "\n", "\"", "\\", "\u2028", "\ufb01", "\ud800"];
  const str = () => Array.from({ length: Math.floor(rand() * 6) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
  const pick = Math.floor(rand() * (depth > 3 ? 5 : 7));
  switch (pick) {
    case 0: return null;
    case 1: return rand() < 0.5;
    case 2: return rand() < 0.5 ? Math.floor(rand() * 2e9) - 1e9 : (rand() - 0.5) * 10 ** Math.floor(rand() * 40 - 20);
    case 3: return str();
    case 4: return rand() < 0.5 ? [] : {};
    case 5: return Array.from({ length: Math.floor(rand() * 5) }, () => randomValue(rand, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(rand() * 6) }, () => [str(), randomValue(rand, depth + 1)]));
  }
}

test("canonicalJson agrees with the consumer implementation on random JSON values", () => {
  const rand = prng(20260925);
  for (let i = 0; i < 2000; i++) {
    const value = randomValue(rand, 0);
    assert.equal(canonicalJson(value), reference(value), `random value ${i}`);
  }
});

test("canonicalJson refuses values that have no single JSON form", () => {
  class Custom { a = 1; }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = [1, , 3];
  const refused: [string, unknown][] = [
    ["undefined", undefined],
    ["undefined member", { a: undefined }],
    ["undefined element", [undefined]],
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["Date", new Date(0)],
    ["class instance", new Custom()],
    ["Map", new Map()],
    ["cycle", cyclic],
    ["sparse array", sparse],
  ];
  for (const [label, value] of refused) assert.throws(() => canonicalJson(value), TypeError, label);
  const shared = { x: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}', "a repeated (acyclic) reference is fine");
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
});

test("sha256Hex hashes strings as UTF-8 and bytes as given", () => {
  const h = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("é"), h(Buffer.from("é", "utf8")));
  assert.equal(sha256Hex(new Uint8Array([0, 1, 2])), h(new Uint8Array([0, 1, 2])));
  assert.match(sha256Hex("x"), /^[0-9a-f]{64}$/);
});
