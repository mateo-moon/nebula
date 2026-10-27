// src/loader/transport.ts
var hex = (bytes2) => [...bytes2].map((b) => b.toString(16).padStart(2, "0")).join("");
function b64(bytes2) {
  let result = "";
  for (let index = 0; index < bytes2.length; index += 16384) result += String.fromCharCode(...bytes2.subarray(index, index + 16384));
  return btoa(result);
}
var bytes = (encoded) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
var utf8 = (text) => new TextEncoder().encode(text);
var hash = async (value) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
function snpPolicy(identity) {
  if (!/^[a-f0-9]{96}$/.test(identity.measurement) || !/^[a-f0-9]{64}$/.test(identity.initDataSha256) || identity.chipId !== void 0 && !/^[a-f0-9]{128}$/.test(identity.chipId)) throw new Error("Invalid expected SNP identity");
  const floors = identity.minimumReportedTcb;
  if (Object.keys(floors).sort().join() !== "bootloader,microcode,snp,tee" || Object.values(floors).some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error("Invalid TCB floor");
  const measurement = b64(Uint8Array.from(identity.measurement.match(/../g), (c) => parseInt(c, 16)));
  return `package policy
import rego.v1
default executables := 33
default hardware := 97
default configuration := 36
default file_system := 35
executables := 3 if approved
hardware := 2 if approved
configuration := 2 if approved
file_system := 2 if approved
approved if {
  input.init_data == ${JSON.stringify(identity.initDataSha256)}
  input.snp.measurement == ${JSON.stringify(measurement)}
  input.snp.policy_debug_allowed == "0"
  input.snp.policy_migrate_ma == "0"
  ${identity.chipId ? `input.snp.chip_id == ${JSON.stringify(identity.chipId)}` : ""}
  ${Object.entries(floors).map(([field, minimum]) => `to_number(input.snp.reported_tcb_${field}) >= ${minimum}`).join("\n  ")}
}`;
}
function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("Use an HTTPS stack endpoint");
  return url.origin;
}
var AttestedChannel = class {
  constructor(fetcher, origin, identity, pin) {
    this.fetcher = fetcher;
    this.identity = identity;
    this.origin = endpoint(origin + (origin.endsWith("/") ? "" : "/"));
    if (pin !== void 0 && !/^[a-f0-9]{64}$/.test(pin)) throw new Error("Invalid instance pin");
    this.pin = pin;
  }
  fetcher;
  identity;
  lastAttestation;
  pin;
  origin;
  async request(path, init = {}) {
    if (!/^\/[A-Za-z0-9/._-]*$/.test(path) || path.includes("..")) throw new Error("Invalid attested API path");
    if (!this.pin && (init.method ?? "GET") !== "GET") throw new Error("Enroll the instance before sending a secret");
    const response = await this.fetcher(this.origin + path, { ...init, credentials: "omit", redirect: "error", cache: "no-store" }, {
      ohttp: { ...this.pin ? { expected_server_public_key: this.pin } : {} },
      verify: {
        model: "background_check",
        as_provider: "coco",
        as_type: "builtin",
        attestation_policy: { type: "inline", content: b64(utf8(snpPolicy(this.identity))) },
        reference_values: []
      }
    });
    const info = response.attest_info;
    if (!info || !/^[a-f0-9]{64}$/.test(info.server_public_key) || !info.attestation_result || this.pin && this.pin !== info.server_public_key) throw new Error("Verified instance key is missing or changed");
    this.pin ??= info.server_public_key;
    this.lastAttestation = info;
    return response;
  }
};

// src/loader/owner.ts
var algorithm = { name: "ECDSA", namedCurve: "P-256" };
var url64 = (value) => b64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
async function seal(key, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(context) }, key, value);
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}
async function open(key, value, context) {
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: bytes(value.iv),
    additionalData: utf8(context)
  }, key, bytes(value.ciphertext)));
}
async function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nebula-confidential-browser-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("owners");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storedOwner(endpoint2) {
  const database = await db();
  try {
    const saved = await new Promise((resolve, reject) => {
      const request = database.transaction("owners").objectStore("owners").get(endpoint2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!saved) return void 0;
    if (saved.version !== 1 || !saved.privateKey || !saved.wrappingKey) throw new Error("Invalid stored owner enrollment");
    const plaintext = await open(saved.wrappingKey, saved, "nebula-profile-v1:" + endpoint2);
    try {
      return { ...JSON.parse(new TextDecoder().decode(plaintext)), privateKey: saved.privateKey, wrappingKey: saved.wrappingKey };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    database.close();
  }
}
async function saveOwner(endpoint2, value) {
  const { privateKey, wrappingKey, ...data } = value;
  const plaintext = utf8(JSON.stringify(data));
  let encrypted;
  try {
    encrypted = await seal(wrappingKey, plaintext, "nebula-profile-v1:" + endpoint2);
  } finally {
    plaintext.fill(0);
  }
  const database = await db();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("owners", "readwrite");
      transaction.objectStore("owners").put({ version: 1, privateKey, wrappingKey, ...encrypted }, endpoint2);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
async function newOwner() {
  const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const encoded = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const privateExport = await seal(wrappingKey, encoded, "nebula-private-export-v1");
  const privateKey = await crypto.subtle.importKey("pkcs8", encoded, algorithm, false, ["sign"]);
  encoded.fill(0);
  const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pemLabel = "PUBLIC KEY";
  const publicKeyPem = `-----BEGIN ${pemLabel}-----
${b64(publicDer).match(/.{1,64}/g).join("\n")}
-----END ${pemLabel}-----
`;
  return { privateKey, wrappingKey, privateExport, publicKeyPem };
}
async function jwt(owner, audience, discovery = false) {
  const now = Math.floor(Date.now() / 1e3), encode = (value) => url64(utf8(JSON.stringify(value)));
  const claims = discovery ? { aud: audience, role: "discovery", iat: now, exp: now + 90 } : { iss: "nebula-owner", aud: audience, sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 120 };
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, owner.privateKey, utf8(unsigned));
  return `${unsigned}.${url64(new Uint8Array(signature))}`;
}
async function encryptedBackup(owner, password) {
  if (password.length < 12) throw new Error("Use a recovery password of at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const source = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 6e5, hash: "SHA-256" },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const { privateKey: _, wrappingKey, privateExport, ...data } = owner;
  const exported = await open(wrappingKey, privateExport, "nebula-private-export-v1");
  const plaintext = utf8(JSON.stringify({ ...data, privateKeyPkcs8: b64(exported) }));
  exported.fill(0);
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8("nebula-owner-v1") }, key, plaintext);
    return { version: 1, kdf: "PBKDF2-SHA256", iterations: 6e5, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
}
async function restoreBackup(text, password) {
  if (text.length > 16 * 1024 * 1024) throw new Error("Recovery file is too large");
  const value = JSON.parse(text);
  if (value.version !== 1 || value.kdf !== "PBKDF2-SHA256" || value.iterations !== 6e5 || bytes(value.salt).length !== 16 || bytes(value.iv).length !== 12) throw new Error("Unsupported recovery file");
  const source = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bytes(value.salt), iterations: 6e5, hash: "SHA-256" },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = await open(key, value, "nebula-owner-v1");
  try {
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    const encoded = bytes(data.privateKeyPkcs8);
    delete data.privateKeyPkcs8;
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const privateExport = await seal(wrappingKey, encoded, "nebula-private-export-v1");
    const privateKey = await crypto.subtle.importKey("pkcs8", encoded, algorithm, false, ["sign"]);
    encoded.fill(0);
    const publicBytes = bytes(data.publicKeyPem.replace(/-----[^-]+-----|\s/g, ""));
    const publicKey = await crypto.subtle.importKey("spki", publicBytes, algorithm, false, ["verify"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) throw new Error("Recovery owner keys disagree");
    return { ...data, privateKey, wrappingKey, privateExport, restored: true };
  } finally {
    plaintext.fill(0);
  }
}

// src/loader/profiles.json
var profiles_default = {
  version: 1,
  profiles: [
    {
      id: "nebula-snp-browser-preparation-coco-2026-10",
      image: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:882424a9f0444a645458a7dfef0e3a3e7961a42cb5a67b60be4b6e1fe7a3b968",
      sourceRevision: "9c954447c006ab220ccc9626dcb7c304bcc34173",
      identity: {
        measurement: "ab3c7da48cbd331623f6de8bb929c4a848a1d6ebee0504c84053c6c648ef807925c314b9d20bcca27075bcff3357dadc",
        initDataSha256: "633d1b2fe7ce6cd964e65b1799aef88b69646729ee7bd8a03eb50d153ace3a97",
        minimumReportedTcb: {
          bootloader: 10,
          tee: 0,
          snp: 24,
          microcode: 88
        }
      }
    },
    {
      id: "nebula-snp-browser-preparation-2026-10",
      image: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:1fc64c90d704a8c702f85116282fddde5c1e12b777f9d579cb9245bc75231de3",
      sourceRevision: "26c890de1eb9ee47c9c1ce4a39d249efd50f9c20",
      identity: {
        measurement: "ab3c7da48cbd331623f6de8bb929c4a848a1d6ebee0504c84053c6c648ef807925c314b9d20bcca27075bcff3357dadc",
        initDataSha256: "3a6179fdd5137b989929ba0d011fad8fb70565f493275827e8813e522602044f",
        minimumReportedTcb: {
          bootloader: 10,
          tee: 0,
          snp: 24,
          microcode: 88
        }
      }
    }
  ]
};

// src/loader/main.ts
var status = (text) => {
  const output = document.getElementById("loader-status");
  if (output) output.textContent = text;
};
var failure = (error) => {
  status(error instanceof Error ? error.message : "Verification failed");
  const recovery = document.getElementById("restore-form");
  if (recovery) recovery.hidden = false;
};
async function verifiedAssets(channel) {
  const response = await channel.request("/ui/manifest.json");
  if (response.status !== 200) throw new Error("The attested UI manifest is unavailable");
  const manifest = await response.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== 3 || manifest.assets.map((a) => a.path).sort().join() !== "/ui/app.js,/ui/index.html,/ui/style.css") throw new Error("Invalid attested UI manifest");
  const result = /* @__PURE__ */ new Map();
  for (const asset of manifest.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid UI asset digest");
    const response2 = await channel.request(asset.path);
    if (response2.status !== 200) throw new Error("An attested UI asset is unavailable");
    const raw = new Uint8Array(await response2.arrayBuffer());
    if (raw.length > 2 * 1024 * 1024 || await hash(raw) !== asset.sha256) throw new Error("Attested UI asset digest mismatch");
    result.set(asset.path, raw);
  }
  return result;
}
async function isolation() {
  if (crossOriginIsolated) return true;
  if (!("serviceWorker" in navigator) || !isSecureContext) throw new Error("This browser needs a secure HTTPS loader origin and WebAssembly isolation support");
  await navigator.serviceWorker.register(new URL("./coi.js", location.href), { scope: "./", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  if (sessionStorage.getItem("nebula-isolation-reload")) throw new Error("Browser isolation is unavailable. Open this link in a browser that supports cross-origin isolation");
  sessionStorage.setItem("nebula-isolation-reload", "1");
  location.reload();
  return false;
}
async function start() {
  if (!await isolation()) return;
  sessionStorage.removeItem("nebula-isolation-reload");
  const parameters = new URLSearchParams(location.hash.slice(1));
  const target = endpoint(parameters.get("endpoint") ?? ""), discovery = endpoint(parameters.get("stack") ?? "");
  let token = parameters.get("token") ?? "";
  const saved = await storedOwner(target);
  if (!saved && !/^[a-f0-9]{64}$/.test(token)) throw new Error("Open the one-time access link from your administrator");
  history.replaceState(null, "", location.pathname + `#endpoint=${encodeURIComponent(target)}&stack=${encodeURIComponent(discovery)}`);
  const sdkUrl = new URL("./sdk/tng_wasm.js", location.href).href;
  const sdk = await import(
    /* @vite-ignore */
    sdkUrl
  );
  await sdk.default(new URL("./sdk/tng_wasm_bg.wasm", location.href).href);
  const fetcher = sdk.fetch;
  let channel;
  let verificationFailure = "No independently approved preparation profile matched";
  for (const profile of profiles_default.profiles) {
    try {
      const candidate = new AttestedChannel(fetcher, target, profile.identity, saved?.preparationPin);
      const response = await candidate.request("/nebula/v1/browser");
      if (response.status === 200) {
        channel = candidate;
        break;
      }
    } catch (error) {
      verificationFailure = error instanceof Error ? error.message.slice(0, 2e3) : String(error).slice(0, 2e3);
    }
  }
  if (!channel) throw new Error(`SNP, workload policy or enrolled instance verification failed. No owner credential or image was sent. ${verificationFailure}`);
  status("SNP and measured preparation workload verified. Loading its UI\u2026");
  const assets = await verifiedAssets(channel);
  const owner = saved ?? await newOwner();
  if (saved?.preparationPin && saved.preparationPin !== channel.pin) throw new Error("The preparation instance changed");
  owner.preparationPin = channel.pin;
  owner.token ??= token;
  token = "";
  const bound = channel;
  Object.defineProperty(window, "nebula", { value: Object.freeze({
    target,
    discovery,
    channel: bound,
    owner,
    fetcher,
    save: () => saveOwner(target, owner),
    jwt: (audience, discovery2 = false) => jwt(owner, audience, discovery2),
    backup: (password) => encryptedBackup(owner, password),
    finalChannel: (origin, identity, pin) => new AttestedChannel(fetcher, origin, identity, pin)
  }), writable: false, configurable: false });
  const html = new DOMParser().parseFromString(new TextDecoder().decode(assets.get("/ui/index.html")), "text/html");
  if (html.querySelector("script, iframe, object, embed, base, link, meta[http-equiv]")) throw new Error("UI document contains an unlisted executable resource");
  const style = document.createElement("style");
  style.textContent = new TextDecoder().decode(assets.get("/ui/style.css"));
  document.head.append(style);
  document.body.replaceChildren(...html.body.childNodes);
  const script = document.createElement("script");
  script.src = URL.createObjectURL(new Blob([assets.get("/ui/app.js")], { type: "text/javascript" }));
  script.onload = () => URL.revokeObjectURL(script.src);
  document.body.append(script);
  const diagnostics = document.createElement("button");
  diagnostics.type = "button";
  diagnostics.className = "secondary";
  diagnostics.textContent = "Check preparation status";
  const diagnosticOutput = document.createElement("pre");
  diagnosticOutput.hidden = true;
  diagnostics.addEventListener("click", () => {
    diagnostics.disabled = true;
    void (async () => {
      const response = await bound.request("/nebula/v1/job", { headers: { Authorization: `Bearer ${await jwt(owner, "nebula-browser")}` } });
      if (response.status !== 200) throw new Error("Owner-authenticated preparation status is unavailable");
      diagnosticOutput.textContent = JSON.stringify(await response.json(), null, 2);
    })().catch((error) => {
      diagnosticOutput.textContent = error instanceof Error ? error.message : "Status unavailable";
    }).finally(() => {
      diagnostics.disabled = false;
      diagnosticOutput.hidden = false;
    });
  });
  (document.querySelector(".progress-card") ?? document.body).append(diagnostics, diagnosticOutput);
}
if (typeof document !== "undefined") {
  document.getElementById("restore-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const file = document.getElementById("restore-file").files?.[0];
      const password = document.getElementById("restore-password");
      if (!file || file.size > 16 * 1024 * 1024) throw new Error("Choose your encrypted recovery file");
      const owner = await restoreBackup(await file.text(), password.value);
      password.value = "";
      const target = endpoint(new URLSearchParams(location.hash.slice(1)).get("endpoint") ?? "");
      await saveOwner(target, owner);
      location.reload();
    })().catch(() => failure(new Error("Recovery failed. Check the file and password. Existing enrollment was preserved.")));
  });
  void start().catch(failure);
}
export {
  verifiedAssets
};
