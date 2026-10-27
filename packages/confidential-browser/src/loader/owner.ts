import { b64, bytes, hash, utf8 } from "./transport";
const algorithm = { name: "ECDSA", namedCurve: "P-256" };
const url64 = (value: Uint8Array) => b64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export interface OwnerState {
  privateKey: CryptoKey; wrappingKey: CryptoKey; publicKeyPem: string;
  privateExport: { iv: string; ciphertext: string };
  preparationPin?: string; finalPin?: string; token?: string;
  finalClaimed?: boolean; provisioned?: boolean; restored?: boolean;
  imageKey?: string; volumeKeys?: Record<string, string>; resources?: Record<string, string>; connection?: any; prepared?: any;
}
async function seal(key: CryptoKey, value: Uint8Array, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(context) }, key, value as BufferSource);
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}
async function open(key: CryptoKey, value: { iv: string; ciphertext: string }, context: string) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv) as BufferSource,
    additionalData: utf8(context) }, key, bytes(value.ciphertext) as BufferSource));
}
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nebula-confidential-browser-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("owners");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function storedOwner(endpoint: string): Promise<OwnerState | undefined> {
  const database = await db();
  try {
    const saved: any = await new Promise((resolve, reject) => {
    const request = database.transaction("owners").objectStore("owners").get(endpoint);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!saved) return undefined;
    if (saved.version !== 1 || !saved.privateKey || !saved.wrappingKey) throw new Error("Invalid stored owner enrollment");
    const plaintext = await open(saved.wrappingKey, saved, "nebula-profile-v1:" + endpoint);
    try { return { ...JSON.parse(new TextDecoder().decode(plaintext)), privateKey: saved.privateKey, wrappingKey: saved.wrappingKey }; }
    finally { plaintext.fill(0); }
  } finally { database.close(); }
}
export async function saveOwner(endpoint: string, value: OwnerState) {
  const { privateKey, wrappingKey, ...data } = value;
  const plaintext = utf8(JSON.stringify(data));
  let encrypted: { iv: string; ciphertext: string };
  try { encrypted = await seal(wrappingKey, plaintext, "nebula-profile-v1:" + endpoint); }
  finally { plaintext.fill(0); }
  const database = await db();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("owners", "readwrite");
    transaction.objectStore("owners").put({ version: 1, privateKey, wrappingKey, ...encrypted }, endpoint);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}
export async function newOwner(): Promise<OwnerState> {
  const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const encoded = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const privateExport = await seal(wrappingKey, encoded, "nebula-private-export-v1");
  const privateKey = await crypto.subtle.importKey("pkcs8", encoded, algorithm, false, ["sign"]);
  encoded.fill(0);
  const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pemLabel = "PUBLIC KEY";
  const publicKeyPem = `-----BEGIN ${pemLabel}-----\n${b64(publicDer).match(/.{1,64}/g)!.join("\n")}\n-----END ${pemLabel}-----\n`;
  return { privateKey, wrappingKey, privateExport, publicKeyPem };
}
export async function jwt(owner: OwnerState, audience: string, discovery = false) {
  const now = Math.floor(Date.now() / 1000), encode = (value: unknown) => url64(utf8(JSON.stringify(value)));
  const claims = discovery ? { aud: audience, role: "discovery", iat: now, exp: now + 90 } :
    { iss: "nebula-owner", aud: audience, sub: "owner", role: "owner", iat: now, nbf: now, exp: now + 120 };
  const unsigned = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, owner.privateKey, utf8(unsigned));
  return `${unsigned}.${url64(new Uint8Array(signature))}`;
}
export async function discoveryAudience(endpoint: string) { return "nebula-discovery:" + await hash(utf8(endpoint)); }
export async function encryptedBackup(owner: OwnerState, password: string) {
  if (password.length < 12) throw new Error("Use a recovery password of at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const source = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, source,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const { privateKey: _, wrappingKey, privateExport, ...data } = owner;
  const exported = await open(wrappingKey, privateExport, "nebula-private-export-v1");
  const plaintext = utf8(JSON.stringify({ ...data, privateKeyPkcs8: b64(exported) })); exported.fill(0);
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8("nebula-owner-v1") }, key, plaintext);
    return { version: 1, kdf: "PBKDF2-SHA256", iterations: 600_000, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
  } finally { plaintext.fill(0); }
}

export async function restoreBackup(text: string, password: string): Promise<OwnerState> {
  if (text.length > 16 * 1024 * 1024) throw new Error("Recovery file is too large");
  const value = JSON.parse(text);
  if (value.version !== 1 || value.kdf !== "PBKDF2-SHA256" || value.iterations !== 600_000 ||
      bytes(value.salt).length !== 16 || bytes(value.iv).length !== 12) throw new Error("Unsupported recovery file");
  const source = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(value.salt) as BufferSource, iterations: 600_000, hash: "SHA-256" },
    source, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = await open(key, value, "nebula-owner-v1");
  try {
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    const encoded = bytes(data.privateKeyPkcs8); delete data.privateKeyPkcs8;
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const privateExport = await seal(wrappingKey, encoded, "nebula-private-export-v1");
    const privateKey = await crypto.subtle.importKey("pkcs8", encoded, algorithm, false, ["sign"]); encoded.fill(0);
    const publicBytes = bytes(data.publicKeyPem.replace(/-----[^-]+-----|\s/g, ""));
    const publicKey = await crypto.subtle.importKey("spki", publicBytes, algorithm, false, ["verify"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) throw new Error("Recovery owner keys disagree");
    return { ...data, privateKey, wrappingKey, privateExport, restored: true };
  } finally { plaintext.fill(0); }
}
