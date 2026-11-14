import { bytes, hash, hex, utf8, b64, AttestedChannel } from "../loader/transport";
import { applicationContract, assertApplicationApproval } from "@nebula/confidential-client/application-approval";
import { discoveryAudience } from "../loader/owner";
import { checkedImageUploadLimits, imageUploadLimits, imageSizeLabel } from "@nebula/confidential-client/image-protocol";
import { checkedSupervisors, storageClientsRunning, checkedStorageRecovery } from "./storage-status";
import { prepareLocalImage, uploadEncryptedImage, removeCipherCache } from "./upload";
const api = window.nebula, owner = api.owner;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => el<HTMLInputElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let connection: any = owner.connection, final: AttestedChannel | undefined;
let busy = false;
let connected = false;
let recoveryUrl: string | undefined;
let imageLimits = imageUploadLimits();
const phases = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"] as const;
type Phase = typeof phases[number];
const phaseLabels: Record<Phase, string> = {
  encrypting: "Encrypt locally and publish ciphertext", measuring: "Compile native genpolicy independently",
  waiting: "Wait for the final confidential workload", attesting: "Verify and enroll its unique instance",
  provisioning: "Provision keys directly to its Trustee", ready: "Unlock storage and authorize app startup",
};
const completed = new Set<Phase>();
let activePhase: Phase | undefined;
function renderSteps() {
  for (const item of document.querySelectorAll<HTMLElement>("[data-phase]")) {
    const phase = item.dataset.phase as Phase, active = phase === activePhase, done = completed.has(phase) && !active;
    item.classList.toggle("active", active); item.classList.toggle("done", done);
    item.setAttribute("aria-label", `${phaseLabels[phase]}: ${done ? "Completed" : active ? "In progress" : "Pending"}`);
    if (active) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
  }
}
function complete(...steps: Phase[]) {
  for (const phase of steps) { completed.add(phase); if (activePhase === phase) activePhase = undefined; }
  renderSteps();
}
const jwtPayload = (jwt: string) => JSON.parse(new TextDecoder().decode(bytes(jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))));
function evidence() {
  const value = { version: 1, checkedAt: new Date().toISOString(), frontend: api.manualTls ? {
    authentication: "User acknowledged an independent check of the browser certificate; this page cannot prove its own initial authenticity",
    reportedCertificate: api.manualTls,
  } : undefined, preparation: {
    expected: api.channel.identity, transportPublicKey: api.channel.pin,
    imageUpload: imageLimits,
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
  busy = false; input("deploy").disabled = !connected || !!owner.prepared;
  activePhase = undefined; renderSteps();
  if (owner.prepared) el("inspect").hidden = false;
}
async function request(channel: AttestedChannel, path: string, method = "GET", body?: BodyInit, audience = "nebula-browser", headers: Record<string, string> = {}) {
  const response = await channel.request(path, { method, headers: { "Content-Type": "application/json", ...headers,
    Authorization: `Bearer ${await api.jwt(audience)}` }, ...(body !== undefined ? { body } : {}) });
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
  if (bootstrap.imageEncryption?.protocol !== "oci-encrypted-v2" || bootstrap.imageEncryption.location !== "owner-browser" || bootstrap.imageEncryption.preparationReceivesImageKey !== false) throw new Error("This preparation service does not support browser-only image encryption");
  if (bootstrap.finalEnrollmentJournal !== 1) throw new Error("This preparation release does not support safe resumable final-instance enrollment");
  imageLimits = checkedImageUploadLimits(bootstrap.imageUpload);
  evidence();
  text("archive-hint", `Choose a local linux/amd64 Docker save archive, up to ${imageSizeLabel(imageLimits.maxBytes)}. Your browser encrypts its layers before upload. Only ciphertext leaves your computer; standard OCI configuration metadata remains readable.`);
  if (!owner.connection) {
    if (bootstrap.claimed) {
      await request(api.channel, "/nebula/v1/job"); // proves the persisted owner, or fails closed
    }
    if (!bootstrap.claimed && await hash(Uint8Array.from((owner.token ?? "").match(/../g) ?? [], (h: any) => parseInt(h, 16))) !== bootstrap.claimSha256) throw new Error("The invitation does not match the attested VM");
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
  const contract = applicationContract(connection);
  text("application-contract", JSON.stringify(contract, null, 2));
  const hasOverrides = contract.containers.some(container => container.execution.source === "override" || Object.keys(container.env).length > 0);
  el("override-review").hidden = !hasOverrides;
  if (owner.approvedRegistry) input("approved-registry").value = owner.approvedRegistry;
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
  if (currentJob.state === "ready" && !owner.prepared) {
    if (!owner.imageKey) throw new Error("Restore the encrypted backup containing this release image key before resuming");
    if (!owner.encryptedImage) {
      const recovery = await (await request(api.channel, "/nebula/v1/image")).json();
      if (recovery.manifestDigest !== currentJob.result.digest) throw new Error("The encrypted recovery metadata differs from the prepared release");
      owner.encryptedImage = { id: "nebula-cipher-" + crypto.randomUUID(), manifestDigest: recovery.manifestDigest, recovery };
    }
    if (currentJob.result.digest !== owner.encryptedImage.manifestDigest) throw new Error("The prepared image does not match your saved browser-encrypted release");
    owner.prepared = currentJob.result; await api.save();
  }
  connected = true;
  input("deploy").disabled = !!owner.prepared; text("job-title", owner.prepared ? "Release prepared" : "Ready when you are");
  text("job-description", "Choose an image and approve the stack. No administrator action is needed.");
  if (owner.prepared) { el("inspect").hidden = false; }
  // These encrypted owner checkpoints describe completed operations, not a
  // fresh health check. Storage readiness is always checked again below.
  if (owner.prepared) {
    complete("encrypting", "measuring");
    if (owner.finalPin) {
      complete("waiting");
      if (owner.finalClaimed) {
        complete("attesting");
        if (owner.provisioned) complete("provisioning");
      }
    }
    text("job-description", "Saved release checkpoints restored. Verify again to check the current workload and storage status.");
  } else if (owner.encryptedImage && currentJob.phase === "measuring") {
    complete("encrypting");
    if (currentJob.state === "running") progress("measuring", "Compiling native genpolicy independently…");
    else text("job-title", "Ciphertext published; native policy needs attention");
    text("job-description", "The attested preparation service confirmed publication of your saved encrypted release. Native policy preparation is not complete.");
  } else renderSteps();
}
function progress(phase: Phase, title: string) {
  text("job-title", title);
  activePhase = phase; completed.delete(phase); renderSteps();
}
async function approveApplication() {
  if (!owner.applicationApproval) {
    if (!input("reviewed").checked) throw new Error("Review and approve the full application command, arguments, environment and storage contract first");
    const contract = applicationContract(connection);
    if (contract.containers.some(container => container.execution.source === "override" || Object.keys(container.env).length > 0) && !input("approve-overrides").checked) {
      throw new Error("This stack requests explicit command or environment overrides. Approve those exact displayed values separately, or use a stack with image defaults.");
    }
    owner.applicationApproval = contract; await api.save();
  }
  assertApplicationApproval(connection, owner.applicationApproval);
}
function approvedRegistry() {
  const host = input("approved-registry").value.trim();
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host) || host !== connection.workload.spec.containers[0].image.split("/")[0]) throw new Error("Enter the registry host you independently trust for these credentials; it must match the displayed destination");
  if (owner.approvedRegistry && owner.approvedRegistry !== host) throw new Error("This owner checkpoint is already bound to another registry host");
  owner.approvedRegistry = host; return host;
}
async function finalConnection() {
  progress(owner.finalPin ? "attesting" : "waiting", owner.finalPin ? "Verifying your enrolled confidential workload…" : "Waiting for your confidential workload…");
  await approveApplication();
  const prepared = owner.prepared;
  const enrollmentResponse = await api.channel.request("/nebula/v1/enrollment", { headers: { Authorization: `Bearer ${await api.jwt("nebula-browser")}` } });
  if (enrollmentResponse.status !== 200 && enrollmentResponse.status !== 404) throw new Error("The attested preparation enrollment journal is unavailable");
  const enrollment = enrollmentResponse.status === 404 ? undefined : await enrollmentResponse.json();
  if (enrollment && (enrollment.version !== 1 || enrollment.manifestDigest !== prepared.digest || !/^[a-f0-9]{64}$/.test(enrollment.transportPublicKey))) throw new Error("The preparation enrollment checkpoint differs from this release");
  if (owner.finalPin && enrollment && owner.finalPin !== enrollment.transportPublicKey) throw new Error("The saved final pin differs from the attested preparation journal");
  if (!enrollment && !owner.finalPin && owner.restored && owner.enrollmentJournalVersion !== 1) throw new Error("This older recovery file predates final instance enrollment. Restore the updated backup; no replacement instance was adopted.");
  const expectedPin = owner.finalPin ?? enrollment?.transportPublicKey;
  const origin = connection.browserEndpoint ?? `${api.target.startsWith("https:") ? "https:" : "http:"}//${connection.endpoint.host}:${connection.endpoint.port}`;
  final = api.finalChannel(origin, prepared.identity, expectedPin);
  const deadline = Date.now() + 900_000;
  while (true) {
    try {
      const response = await final!.request("/nebula/v1/instance", { headers: { Authorization: `Bearer ${await api.jwt(prepared.audience)}` } });
      if (response.status !== 200) throw new Error("Owner authentication failed");
      break;
    } catch (error) {
      if (expectedPin) throw error;
      if (Date.now() >= deadline) throw new Error("Your encrypted image and release checkpoint are saved. The final confidential workload is not reachable yet; use Verify again & check status to retry. No keys were sent to an unverified instance.");
      await sleep(4000);
    }
  }
  complete("waiting");
  progress("attesting", "Attestation passed. Checking final instance enrollment…");
  if (!enrollment) {
    const committed = await (await request(api.channel, "/nebula/v1/enrollment", "POST", JSON.stringify({
      version: 1, manifestDigest: prepared.digest, transportPublicKey: final!.pin }))).json();
    if (committed.manifestDigest !== prepared.digest || committed.transportPublicKey !== final!.pin) throw new Error("Final instance enrollment was not committed by the pinned preparation VM");
  }
  if (!owner.finalPin) { owner.finalPin = final!.pin; await api.save(); }
  if (!owner.finalClaimed) {
    const claimed = await final!.request("/nebula/v1/claim", { method: "POST", headers: { Authorization: `Bearer ${await api.jwt(prepared.audience)}` },
      body: JSON.stringify({ token: owner.token, ownerPublicKeyPem: owner.publicKeyPem }) });
    if (claimed.status !== 200 && claimed.status !== 409) throw new Error("Final instance claim was refused; no keys were sent");
    await request(final!, "/kbs/v0/resource-policy", "GET", undefined, prepared.audience);
    owner.finalClaimed = true; delete owner.token; await api.save();
  }
  complete("attesting");
  evidence(); text("final-status", "Final workload verified"); return final!;
}
async function provision() {
  await approveApplication();
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
  complete("provisioning");
  await inspect();
}
async function inspect() {
  const channel = final ?? await finalConnection();
  const deadline = Date.now() + 300_000;
  const resources = connection.workload.spec.resources.map((path: string[]) => path.join("/"));
  const encryptedStorage = (connection.workload.spec.storage ?? []).filter((binding: { resource: string }) => {
    const storage = connection.storages.find((value: any) => value.metadata.name === binding.resource &&
      value.metadata.namespace === connection.workload.metadata.namespace);
    if (!storage) throw new Error("Declared storage is missing from the verified stack");
    return storage.spec.type === "EncryptedBlock";
  }).map((binding: { name: string }) => binding.name);
  progress("ready", "Checking workload and encrypted storage…");
  while (true) {
    const status = await (await request(channel, "/nebula/v1/bootstrap", "GET", undefined, owner.prepared.audience)).json();
    text("result", JSON.stringify(status, null, 2)); evidence();
    const helperResponse = await channel.request("/nebula/v1/supervisors", { headers: { Authorization: `Bearer ${await api.jwt(owner.prepared.audience)}` } });
    let clientsRunning = false;
    if (helperResponse.status === 200) {
      const report = checkedSupervisors(await helperResponse.json());
      text("supervisor-status", "Process supervision only; application readiness is unknown.\n" + JSON.stringify(report, null, 2));
      clientsRunning = storageClientsRunning(report, encryptedStorage);
    } else if (helperResponse.status === 404) {
      text("supervisor-status", "This release has no supervisor report. Bootstrap readiness does not prove application health.");
      clientsRunning = true;
    } else if (helperResponse.status === 503) text("supervisor-status", "Supervisor status is temporarily unavailable; startup cannot be reported complete.");
    else throw new Error("Owner-authenticated supervisor status is unavailable");
    if (clientsRunning && status.phase !== "awaiting-configuration" && resources.length > 0 &&
        resources.every((path: string) => status.resources?.[path]?.status === 200) &&
        encryptedStorage.every((name: string) => status.storage?.[name]?.phase === "ready")) break;
    if (Date.now() >= deadline) throw new Error("Keys reached the verified VM. Startup is still pending; use Verify again for status.");
    await sleep(4000);
  }
  complete("ready");
  text("job-title", "Keys delivered; encrypted storage unlocked"); text("job-description", "The final VM passed fresh attestation and accepted your owner keys. App startup is authorized; application health is checked separately.");
  el("inspect").hidden = false;
}
el("deploy-form").addEventListener("submit", event => {
  event.preventDefault(); if (busy || !connected) return; busy = true; input("deploy").disabled = true;
  void (async () => {
    const archive = input("archive").files?.[0];
    if (!archive || !archive.size || archive.size > imageLimits.maxBytes) {
      throw new Error(`Choose one nonempty local image archive up to ${imageSizeLabel(imageLimits.maxBytes)}`);
    }
    await approveApplication();
    const registry = approvedRegistry();
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
    completed.clear();
    progress("encrypting", "Encrypting image locally in your browser…");
    if (!owner.encryptedImage) {
      if (owner.cipherCacheAttempt) await removeCipherCache({ id: owner.cipherCacheAttempt, manifestDigest: "" });
      owner.cipherCacheAttempt = "nebula-cipher-" + crypto.randomUUID(); await api.save();
    }
    const local = await prepareLocalImage(archive, owner.imageKey, `kbs:///${connection.workload.spec.containers[0].imageKeyResource.join("/")}`,
      imageLimits, owner.encryptedImage, (done, total) => progress("encrypting", `Encrypting locally: ${imageSizeLabel(done)} / ${imageSizeLabel(total)} (${Math.floor(done * 100 / total)}%)`), owner.cipherCacheAttempt);
    owner.encryptedImage = local.cache; delete owner.cipherCacheAttempt; await api.save();
    download("nebula-owner-recovery-updated.json", await api.backup(recoveryPassword));
    await uploadEncryptedImage(local.image, imageLimits,
      (path, method, body, headers) => request(api.channel, path, method, body, "nebula-browser", headers),
      (sent, total) => progress("encrypting", `Uploading encrypted layers: ${imageSizeLabel(sent)} / ${imageSizeLabel(total)} (${Math.floor(sent * 100 / total)}%)`));
    progress("encrypting", "Publishing your encrypted image…");
    await request(api.channel, "/nebula/v1/publish", "POST", JSON.stringify({
      registryUsername: input("registry-username").value, registryPassword: input("registry-password").value,
      approvedRegistry: registry, applicationApproval: owner.applicationApproval }));
    input("registry-password").value = "";
    const deadline = Date.now() + imageLimits.jobTimeoutMs;
    while (true) {
      if (Date.now() >= deadline) throw new Error("Preparation is still pending. Your keys and release checkpoint were preserved.");
      await sleep(3000);
      const job = await (await request(api.channel, "/nebula/v1/job")).json();
      if (job.phase === "measuring" && job.state !== "ready") {
        complete("encrypting"); progress("measuring", "Compiling native genpolicy independently…");
      }
      if (job.state === "failed") throw new Error(`Preparation stopped during ${job.phase ?? "publication"}: ${job.error ?? "native publication or policy generation failed"}`);
      if (job.state === "ready") {
        if (job.result.digest !== local.image.manifestDigest) throw new Error("Published image differs from your browser-encrypted release");
        owner.prepared = job.result; await api.save();
        complete("encrypting", "measuring");
        await removeCipherCache(owner.encryptedImage); delete owner.encryptedImage; await api.save(); break;
      }
    }
    await provision(); busy = false;
    } finally {
      if (owner.prepared || owner.finalPin) download("nebula-owner-recovery-updated.json", await api.backup(recoveryPassword));
      recoveryPassword = "";
    }
  })().catch(failure);
});
el("inspect").addEventListener("click", () => { if (!busy && connected) { busy = true; el("notice").hidden = true; void (owner.provisioned ? inspect() : provision()).then(() => { busy = false; }).catch(failure); } });
el("storage-recovery").addEventListener("click", () => {
  if (busy || !owner.finalPin || !owner.prepared) return;
  void (async () => {
    const channel = final ?? await finalConnection();
    const resources: Record<string,string> = {};
    for (const binding of connection.workload.spec.storage ?? []) {
      const storage = connection.storages.find((value: any) => value.metadata.name === binding.resource && value.metadata.namespace === connection.workload.metadata.namespace);
      if (storage?.spec.type === "EncryptedBlock") resources[binding.name] = storage.spec.keyResource.join("/");
    }
    const instance = await (await request(channel, "/nebula/v1/instance", "GET", undefined, owner.prepared.audience)).json();
    const plans = checkedStorageRecovery(await (await request(channel, "/nebula/v1/storage-recovery", "GET", undefined, owner.prepared.audience)).json(), instance.publicKeySha256, resources);
    const output = el("storage-recovery-plans"); output.replaceChildren();
    if (!plans.length) { output.textContent = "No interrupted empty-filesystem initialization is eligible for automatic recovery. Existing or nonzero data requires manual recovery."; return; }
    for (const plan of plans) {
      const expires = Date.now() + plan.expiresInSeconds * 1000;
      const panel = document.createElement("section"), details = document.createElement("pre"), label = document.createElement("label"), approval = document.createElement("input"), button = document.createElement("button");
      details.textContent = JSON.stringify(plan, null, 2); approval.type = "checkbox"; button.type = "button"; button.className = "secondary";
      label.append(approval, document.createTextNode(" I authorize resuming only this verified empty filesystem. The enrolled guest must refuse existing filesystems or nonzero payloads."));
      button.textContent = "Resume verified empty initialization";
      button.addEventListener("click", () => {
        if (!approval.checked || Date.now() >= expires) { text("notice", "Approve this exact empty-filesystem recovery, or refresh an expired challenge first."); el("notice").hidden = false; return; }
        button.disabled = true;
        void request(channel, "/nebula/v1/storage-recovery", "POST", JSON.stringify({ version: 1, storage: plan.storage, instance: plan.instance, headerSha256: plan.headerSha256, challenge: plan.challenge, action: plan.action, acknowledgement: "RESUME ONLY THIS VERIFIED EMPTY FILESYSTEM" }), owner.prepared.audience)
          .then(() => { panel.textContent = "Recovery accepted by the same enrolled guest. Verify startup status again; this is not application health proof."; }).catch(error => { button.disabled = false; failure(error); });
      });
      panel.append(details, label, button); output.append(panel);
    }
  })().catch(failure);
});
el("clear-local-cache").addEventListener("click", () => {
  if (busy) return;
  void (async () => {
    if (owner.encryptedImage) await removeCipherCache(owner.encryptedImage);
    if (owner.cipherCacheAttempt) await removeCipherCache({ id: owner.cipherCacheAttempt, manifestDigest: "" });
    delete owner.cipherCacheAttempt; await api.save();
    text("notice", "Local ciphertext cache cleared. Keep your latest encrypted recovery backup and original image archive; their saved metadata can recreate the identical encrypted release.");
    el("notice").hidden = false;
  })().catch(failure);
});
el("download-verification").addEventListener("click", () => download("nebula-verification.json", evidence()));
void connect().catch(failure);
