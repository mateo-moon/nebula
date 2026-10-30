import { bytes, hash, hex, utf8, b64, AttestedChannel } from "../loader/transport";
import { discoveryAudience } from "../loader/owner";
const api = window.nebula, owner = api.owner;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => el<HTMLInputElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let connection: any = owner.connection, final: AttestedChannel | undefined;
let busy = false;
let recoveryUrl: string | undefined;
const jwtPayload = (jwt: string) => JSON.parse(new TextDecoder().decode(bytes(jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))));
function evidence() {
  const value = { version: 1, checkedAt: new Date().toISOString(), frontend: api.manualTls ? {
    authentication: "User acknowledged an independent check of the browser certificate; this page cannot prove its own initial authenticity",
    reportedCertificate: api.manualTls,
  } : undefined, preparation: {
    expected: api.channel.identity, transportPublicKey: api.channel.pin,
    result: api.channel.lastAttestation ? jwtPayload(api.channel.lastAttestation.attestation_result) : undefined,
    jwt: api.channel.lastAttestation?.attestation_result,
  }, final: final?.lastAttestation ? { expected: final.identity, transportPublicKey: final.pin,
    result: jwtPayload(final.lastAttestation.attestation_result), jwt: final.lastAttestation.attestation_result } : undefined };
  text("preparation-attestation", JSON.stringify(value.preparation, null, 2));
  if (value.frontend) {
    el("frontend-proof").hidden = false;
    text("frontend-certificate", JSON.stringify(value.frontend, null, 2));
  }
  if (value.final) text("final-attestation", JSON.stringify(value.final, null, 2));
  return value;
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name;
  if (name.startsWith("nebula-owner-recovery")) {
    if (recoveryUrl) URL.revokeObjectURL(recoveryUrl);
    recoveryUrl = url;
    document.getElementById("recovery-download")?.remove();
    a.id = "recovery-download"; a.className = "secondary";
    a.textContent = name.includes("updated") ? "Download updated encrypted recovery backup" : "Download encrypted recovery backup";
    el("deploy-form").after(a);
  } else setTimeout(() => URL.revokeObjectURL(url), 10_000);
  a.click();
}
function failure(error: unknown) {
  const notice = el("notice"); notice.hidden = false;
  notice.textContent = error instanceof Error ? error.message : "Verification or deployment stopped. No unverified fallback was used.";
  busy = false; input("deploy").disabled = !connection;
}
async function request(channel: AttestedChannel, path: string, method = "GET", body?: BodyInit, audience = "nebula-browser") {
  const response = await channel.request(path, { method, headers: { Authorization: `Bearer ${await api.jwt(audience)}`, "Content-Type": "application/json" }, ...(body !== undefined ? { body } : {}) });
  if (response.status < 200 || response.status >= 300) throw new Error(`The attested service refused ${path} (${response.status}). Existing enrollment was preserved.`);
  return response;
}
async function metadata(method = "GET", claim = false, ownerOnly = false) {
  const audience = await discoveryAudience(api.discovery + "/");
  const headers: Record<string,string> = { Authorization: owner.token && !owner.connection && !ownerOnly ? `Bootstrap ${owner.token}` : `Bearer ${await api.jwt(audience, true)}` };
  const response = await fetch(api.discovery + "/.well-known/nebula/confidential" + (claim ? "/claim" : ""), {
    method, headers: { ...headers, ...(claim ? { "Content-Type": "application/json" } : {}) }, cache: "no-store", credentials: "omit", redirect: "error",
    ...(claim ? { body: JSON.stringify({ ownerPublicKeyPem: owner.publicKeyPem, proof: await api.jwt(audience, true) }) } : {}),
  });
  if (response.status === 403 && !ownerOnly) return metadata(method, claim, true);
  if (response.status !== 200) throw new Error("The stack metadata could not be authenticated");
  return claim ? undefined : await response.json();
}
async function connect() {
  evidence();
  const bootstrap = await (await api.channel.request("/nebula/v1/browser")).json();
  if (!owner.connection) {
    if (bootstrap.claimed) {
      await request(api.channel, "/nebula/v1/job"); // proves the persisted owner, or fails closed
    }
    if (await hash(Uint8Array.from(owner.token.match(/../g), (h: any) => parseInt(h, 16))) !== bootstrap.claimSha256) throw new Error("The invitation does not match the attested VM");
    // Persist the exact instance and owner before claiming, so a reload cannot
    // silently generate another owner or adopt a replacement instance.
    await api.save();
    if (!bootstrap.claimed) await request(api.channel, "/nebula/v1/claim", "POST", JSON.stringify({ token: owner.token, ownerPublicKeyPem: owner.publicKeyPem }));
    const found = await metadata();
    connection = found.connection;
    if (!connection) throw new Error("Stack settings are unavailable");
    const savedConnection = await api.channel.request("/nebula/v1/connection", { headers: { Authorization: `Bearer ${await api.jwt("nebula-browser")}` } });
    if (savedConnection.status === 404) await request(api.channel, "/nebula/v1/connection", "POST", JSON.stringify(connection));
    else if (savedConnection.status !== 200 || JSON.stringify(await savedConnection.json()) !== JSON.stringify(connection)) throw new Error("The preparation release differs from discovery");
    await metadata("POST", true);
    owner.connection = connection; await api.save();
  }
  connection = owner.connection;
  const actual = await (await request(api.channel, "/nebula/v1/connection")).json();
  if (JSON.stringify(actual) !== JSON.stringify(connection)) throw new Error("Stored and attested release settings disagree");
  text("connection-status", "You own this attested preparation instance. Future operations require your browser’s owner signature.");
  text("stack-name", connection.workload.spec.profile);
  text("destination", "Encrypted image destination: " + connection.workload.spec.containers[0].image);
  text("configuration", JSON.stringify(connection, null, 2));
  text("security-values", "Preparation instance: " + api.channel.pin);
  text("storage-summary", connection.storages.map((s: any) => `${s.metadata.name}: ${s.spec.type}`).join(" · "));
  for (const storage of connection.storages) {
    if (storage.spec.type !== "EncryptedBlock" || storage.spec.initialization !== "Never") continue;
    const label = document.createElement("label"); label.textContent = `Existing disk key: ${storage.metadata.name}`;
    const field = document.createElement("input"); field.type = "file"; field.id = "key-" + storage.metadata.name;
    el("volume-keys").append(label, field);
  }
  const keyPaths = new Set([connection.workload.spec.containers[0].imageKeyResource.join("/"),
    ...connection.storages.filter((s: any) => s.spec.type === "EncryptedBlock").map((s: any) => s.spec.keyResource.join("/"))]);
  for (const resource of connection.workload.spec.resources) {
    const path = resource.join("/"); if (keyPaths.has(path)) continue;
    const label = document.createElement("label"); label.textContent = `Private application resource: ${path}`;
    const field = document.createElement("input"); field.type = "file"; field.id = "resource-" + path;
    el("resource-files").append(label, field);
  }
  const currentJob = await (await request(api.channel, "/nebula/v1/job")).json();
  if (currentJob.state === "ready" && !owner.prepared) { owner.prepared = currentJob.result; await api.save(); }
  input("deploy").disabled = !!owner.prepared; text("job-title", owner.prepared ? "Release prepared" : "Ready when you are");
  text("job-description", "Choose an image and approve the stack. No administrator action is needed.");
  if (owner.prepared) { el("inspect").hidden = false; }
}
function progress(phase: string, title: string) {
  text("job-title", title);
  for (const item of document.querySelectorAll<HTMLElement>("[data-phase]")) item.classList.toggle("active", item.dataset.phase === phase);
}
async function finalConnection() {
  const prepared = owner.prepared;
  const origin = connection.browserEndpoint ?? `${api.target.startsWith("https:") ? "https:" : "http:"}//${connection.endpoint.host}:${connection.endpoint.port}`;
  final = api.finalChannel(origin, prepared.identity, owner.finalPin);
  const deadline = Date.now() + 900_000;
  while (true) {
    try {
      const response = await final!.request("/nebula/v1/instance", { headers: { Authorization: `Bearer ${await api.jwt(prepared.audience)}` } });
      if (response.status !== 200) throw new Error("Owner authentication failed");
      break;
    } catch (error) { if (owner.finalPin || Date.now() >= deadline) throw error; await sleep(4000); }
  }
  if (!owner.finalPin) {
    if (owner.restored) throw new Error("This recovery file predates final instance enrollment. Restore the updated backup; no replacement instance was adopted.");
    owner.finalPin = final!.pin; await api.save();
  }
  if (!owner.finalClaimed) {
    const claimed = await final!.request("/nebula/v1/claim", { method: "POST", headers: { Authorization: `Bearer ${await api.jwt(prepared.audience)}` },
      body: JSON.stringify({ token: owner.token, ownerPublicKeyPem: owner.publicKeyPem }) });
    if (claimed.status !== 200 && claimed.status !== 409) throw new Error("Final instance claim was refused; no keys were sent");
    await request(final!, "/kbs/v0/resource-policy", "GET", undefined, prepared.audience);
    owner.finalClaimed = true; delete owner.token; await api.save();
  }
  evidence(); return final!;
}
async function provision() {
  progress("waiting", "Waiting for your confidential workload…");
  const channel = await finalConnection(), prepared = owner.prepared;
  progress("provisioning", "Verified final instance. Provisioning keys…");
  const encode = (text: string) => b64(utf8(text)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  await request(channel, "/kbs/v0/attestation-policy", "POST", JSON.stringify({ type: "rego", policy_id: "default_cpu", policy: encode(prepared.policies.attestationPolicy) }), prepared.audience);
  await request(channel, "/kbs/v0/resource-policy", "POST", JSON.stringify({ policy: encode(prepared.policies.resourcePolicy) }), prepared.audience);
  const put = async (path: string[], key: string) => {
    const raw = Uint8Array.from(key.match(/../g)!, h => parseInt(h, 16));
    try { await request(channel, "/kbs/v0/resource/" + path.join("/"), "POST", raw as BodyInit, prepared.audience); }
    finally { raw.fill(0); }
  };
  await put(prepared.imageKeyResource, owner.imageKey);
  for (const storage of connection.storages) if (storage.spec.type === "EncryptedBlock") await put(storage.spec.keyResource, owner.volumeKeys[storage.metadata.name]);
  for (const [path, encoded] of Object.entries(owner.resources ?? {})) {
    const raw = bytes(encoded as string);
    try { await request(channel, "/kbs/v0/resource/" + path, "POST", raw as BodyInit, prepared.audience); }
    finally { raw.fill(0); }
  }
  owner.provisioned = true; await api.save();
  await inspect();
}
async function inspect() {
  const channel = final ?? await finalConnection();
  const deadline = Date.now() + 300_000;
  progress("ready", "Checking workload and encrypted storage…");
  while (true) {
    const status = await (await request(channel, "/nebula/v1/bootstrap", "GET", undefined, owner.prepared.audience)).json();
    text("result", JSON.stringify(status, null, 2)); evidence();
    if (status.phase !== "awaiting-configuration" && Object.keys(status.resources ?? {}).length > 0 &&
        Object.values(status.resources).every((v: any) => v.status === 200) && Object.values(status.storage ?? {}).every((v: any) => v.phase === "ready")) break;
    if (Date.now() >= deadline) throw new Error("Keys reached the verified VM. Startup is still pending; use Verify again for status.");
    await sleep(4000);
  }
  text("job-title", "Keys delivered; encrypted storage unlocked"); text("job-description", "The final VM passed fresh attestation and accepted your owner keys. Workload startup is now authorized.");
  text("final-status", "Final workload verified"); el("inspect").hidden = false;
}
el("deploy-form").addEventListener("submit", event => {
  event.preventDefault(); if (busy) return; busy = true; input("deploy").disabled = true;
  void (async () => {
    const archive = input("archive").files?.[0], sourceImage = input("source-image").value.trim();
    if ((!archive && !sourceImage) || (archive && sourceImage) || (archive && archive.size > 256 * 1024 * 1024)) throw new Error("Choose one image archive up to 256 MiB, or one registry image");
    if (!input("reviewed").checked) throw new Error("Review and approve the stack first");
    owner.imageKey ??= hex(crypto.getRandomValues(new Uint8Array(32))); owner.volumeKeys ??= {};
    for (const storage of connection.storages) if (storage.spec.type === "EncryptedBlock" && !owner.volumeKeys[storage.metadata.name]) {
      const selected = (document.getElementById("key-" + storage.metadata.name) as HTMLInputElement | null)?.files?.[0];
      if (storage.spec.initialization === "Never" && !selected) throw new Error("Provide the existing encrypted disk key");
      const raw = selected ? new Uint8Array(await selected.arrayBuffer()) : crypto.getRandomValues(new Uint8Array(32));
      if (raw.length !== 32) throw new Error("Disk keys must contain exactly 32 bytes");
      owner.volumeKeys[storage.metadata.name] = hex(raw); raw.fill(0);
    }
    owner.resources ??= {};
    for (const field of el("resource-files").querySelectorAll<HTMLInputElement>("input")) {
      const path = field.id.slice("resource-".length), selected = field.files?.[0];
      if (!selected && !owner.resources[path]) throw new Error(`Provide the private application resource ${path}`);
      if (selected) {
        if (selected.size < 1 || selected.size > 2 * 1024 * 1024) throw new Error("Application resources must be at most 2 MiB");
        const raw = new Uint8Array(await selected.arrayBuffer());
        owner.resources[path] = b64(raw); raw.fill(0);
      }
    }
    await api.save();
    let recoveryPassword = input("recovery-password").value;
    download("nebula-owner-recovery.json", await api.backup(recoveryPassword)); input("recovery-password").value = "";
    try {
    progress("encrypting", "Encrypting and publishing in the verified VM…");
    if (archive) await request(api.channel, "/nebula/v1/image", "PUT", archive);
    await request(api.channel, "/nebula/v1/publish", "POST", JSON.stringify({ imageKey: owner.imageKey,
      registryUsername: input("registry-username").value, registryPassword: input("registry-password").value, ...(sourceImage ? { sourceImage } : {}) }));
    input("registry-password").value = "";
    const deadline = Date.now() + 900_000;
    while (true) {
      if (Date.now() >= deadline) throw new Error("Preparation is still pending. Your keys and release checkpoint were preserved.");
      await sleep(3000);
      const job = await (await request(api.channel, "/nebula/v1/job")).json();
      if (job.state === "failed") throw new Error(`Preparation stopped during ${job.phase ?? "publication"}: ${job.error ?? "native publication or policy generation failed"}`);
      if (job.state === "ready") { owner.prepared = job.result; await api.save(); break; }
    }
    await provision(); busy = false;
    } finally {
      if (owner.prepared || owner.finalPin) download("nebula-owner-recovery-updated.json", await api.backup(recoveryPassword));
      recoveryPassword = "";
    }
  })().catch(failure);
});
el("inspect").addEventListener("click", () => { if (!busy) { busy = true; void (owner.provisioned ? inspect() : provision()).then(() => { busy = false; }).catch(failure); } });
el("download-verification").addEventListener("click", () => download("nebula-verification.json", evidence()));
void connect().catch(failure);
