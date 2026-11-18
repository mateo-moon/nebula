import { bytes, hash, hex, utf8, b64, AttestedChannel } from "../loader/transport";
import { applicationContract, assertApplicationApproval } from "@nebula/confidential-client/application-approval";
import { discoveryAudience } from "../loader/owner";
import { checkedImageUploadLimits, imageUploadLimits, imageSizeLabel } from "@nebula/confidential-client/image-protocol";
import { checkedSupervisors, storageClientsRunning, checkedStorageRecovery } from "./storage-status";
import { prepareLocalImage, prepareRegistryImage, uploadEncryptedImage, removeCipherCache, type LocalCipherImage, type CipherCache } from "./upload";
import { summarizeStorage, renderStorageOverview, type StorageSummary } from "@nebula/confidential-client/storage-overview";
import { readinessSummary, type StatusLabel } from "./readiness";
import { registryReference, sourceImageKey, sourceKeyFromRecovery } from "./registry-source";
import { verificationDownload } from "./verification-download";
import type { SupervisorReport } from "./storage-status";
const api = window.nebula, owner = api.owner;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => el<HTMLInputElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
const sourceMode = () => (document.getElementById("image-source") as HTMLSelectElement | null)?.value === "registry" ? "registry" : "local";
function sourceControls() {
  const registry = sourceMode() === "registry";
  const local = document.getElementById("local-source-inputs"), remote = document.getElementById("registry-source-inputs");
  if (local) local.hidden = registry; if (remote) remote.hidden = !registry;
  input("archive").required = !registry;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let connection: any = owner.connection, final: AttestedChannel | undefined;
let busy = false;
let connected = false;
let recoveryUrl: string | undefined;
let imageLimits = imageUploadLimits();
let storageCards: StorageSummary[] = [];
let currentReadiness = false;
let readinessChecking = false;
let lastReadiness: ReturnType<typeof readinessSummary> | undefined;
let lastReadinessTime: string | undefined;
const phases = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"] as const;
type Phase = typeof phases[number];
const phaseLabels: Record<Phase, string> = {
  encrypting: "Encrypt locally and publish ciphertext", measuring: "Prepare the approved workload policy",
  waiting: "Wait for the final confidential VM", attesting: "Verify and enroll that VM",
  provisioning: "Deliver keys to its Trustee", ready: "Unlock disks and authorize app startup",
};
const completed = new Set<Phase>();
let activePhase: Phase | undefined;
function statusRows(rows: { name: string; status: StatusLabel }[]) {
  const parent = el("readiness-checks"); parent.replaceChildren();
  for (const { name, status } of rows) {
    const group = document.createElement("div"), label = document.createElement("dt"), value = document.createElement("dd"), detail = document.createElement("p");
    label.textContent = name; value.textContent = status.label; value.dataset.tone = status.tone;
    detail.className = "hint"; detail.textContent = status.detail;
    group.append(label, value, detail); parent.append(group);
  }
}
function unconfirmedReadiness(checking = false) {
  readinessChecking = checking;
  currentReadiness = false;
  lastReadiness = undefined; lastReadinessTime = undefined;
  text("readiness-title", checking ? "Checking live data readiness…" : "Not checked yet");
  text("readiness-description", "Configured volumes and saved deployment steps are not a current readiness check. Each encrypted disk must be confirmed by the verified final guest.");
  text("readiness-time", checking ? "A fresh owner-authenticated check is in progress." : "No live final-workload check yet.");
  const pending: StatusLabel = { label: checking ? "Checking…" : "Not checked yet", detail: "Checked after the final VM is verified and your keys are delivered.", tone: "pending" };
  statusRows([{ name: "Required secrets", status: pending }, { name: "Encrypted disks", status: pending },
    { name: "Application process", status: pending }, { name: "Application health", status: { label: "Not checked", detail: "Use your application's own health endpoint. A running process does not establish application health.", tone: "neutral" } }]);
  renderStorageOverview(el("storage-summary"), storageCards);
}
function showReadiness(snapshot: unknown, report: SupervisorReport | undefined, source: "reported" | "unsupported" | "unavailable") {
  const required = { resources: connection.workload.spec.resources.map((path: string[]) => path.join("/")),
    encryptedStorage: storageCards.filter(storage => storage.type === "EncryptedBlock").map(storage => storage.name) };
  const summary = readinessSummary(required, snapshot, report, source);
  currentReadiness = true; lastReadiness = summary;
  text("readiness-title", summary.title); text("readiness-description", summary.description);
  statusRows([{ name: "Required secrets", status: summary.keys }, { name: "Encrypted disks", status: summary.storage },
    { name: "Application process", status: summary.process }, { name: "Application health", status: summary.health }]);
  lastReadinessTime = new Date(Date.now()).toLocaleString();
  text("readiness-time", `Last checked ${lastReadinessTime}. Refresh to verify the current state again.`);
  renderStorageOverview(el("storage-summary"), storageCards, summary.disks);
  return summary;
}
function staleReadiness() {
  if (!lastReadiness) return;
  const stale = (status: StatusLabel): StatusLabel => ({ ...status, label: "Last check: " + status.label, tone: "neutral" });
  text("readiness-title", "Readiness check stopped");
  text("readiness-description", "The last observations are shown below. Resolve the reported issue and refresh status; these are not a new successful check.");
  statusRows([{ name: "Required secrets", status: stale(lastReadiness.keys) }, { name: "Encrypted disks", status: stale(lastReadiness.storage) },
    { name: "Application process", status: stale(lastReadiness.process) }, { name: "Application health", status: lastReadiness.health }]);
  renderStorageOverview(el("storage-summary"), storageCards, Object.fromEntries(Object.entries(lastReadiness.disks).map(([name, status]) => [name, stale(status)])));
  text("readiness-time", `Last response ${lastReadinessTime}. The check did not complete.`);
  currentReadiness = false;
}
function selectionChecklist() {
  if (!connection) return;
  const archive = input("archive").files?.[0];
  const existing = storageCards.filter(storage => storage.type === "EncryptedBlock" && connection.storages.find((s: any) => s.metadata.name === storage.resourceName)?.spec.initialization === "Never");
  const keyFiles = existing.filter(storage => owner.volumeKeys?.[storage.resourceName] || (document.getElementById("key-" + storage.resourceName) as HTMLInputElement | null)?.files?.length).length;
  const files = Array.from(el("resource-files").querySelectorAll<HTMLInputElement>("input"));
  const selected = files.filter(field => field.files?.length || owner.resources?.[field.id.slice("resource-".length)]).length;
  const hasOverrides = applicationContract(connection).containers.some(container => container.execution.source === "override" || Object.keys(container.env).length > 0);
  const items = [
    { label: sourceMode() === "registry" ? "Registry source · verified and encrypted locally" : archive ? "Local image archive selected" : `Local image archive · up to ${imageSizeLabel(imageLimits.maxBytes)}`, supplied: sourceMode() === "registry" ? !!(document.getElementById("source-reference") as HTMLInputElement | null)?.value : !!archive || !!owner.prepared },
    { label: "Image storage · managed by this stack", supplied: !!connection.workload.spec.imageStore || !!owner.prepared },
    { label: existing.length ? `Existing disk keys · ${keyFiles} of ${existing.length} selected or saved` : "New disk keys · generated automatically in your browser", supplied: keyFiles === existing.length },
    { label: files.length ? `Private application files · ${selected} of ${files.length} selected or saved` : "No private application files requested", supplied: selected === files.length },
    { label: "Recovery backup password · at least 12 characters", supplied: input("recovery-password").value.length >= 12 },
    { label: "Application and storage settings reviewed", supplied: !!owner.applicationApproval || input("reviewed").checked && (!hasOverrides || input("approve-overrides").checked) },
  ];
  const list = el("input-checklist"); list.replaceChildren();
  for (const item of items) {
    const row = document.createElement("li"), marker = document.createElement("span"), label = document.createElement("span");
    marker.textContent = item.supplied ? "✓" : "○"; marker.setAttribute("aria-hidden", "true");
    label.textContent = item.label; row.dataset.supplied = String(item.supplied); row.append(marker, label); list.append(row);
  }
}
function fileSelection(field: HTMLInputElement, label: string, options: { saved?: () => boolean; clear?: () => void } = {}) {
  const row = document.createElement("div"), detail = document.createElement("div"), filename = document.createElement("strong");
  const status = document.createElement("span"), remove = document.createElement("button");
  row.className = "file-selection"; row.id = field.id + "-selection";
  detail.setAttribute("aria-live", "polite"); detail.append(filename, status);
  remove.type = "button"; remove.className = "text-button";
  remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove selected ${label}`);
  row.append(detail, remove); field.after(row);
  const render = () => {
    const file = field.files?.[0], saved = options.saved?.();
    if (options.saved) field.required = !saved;
    row.hidden = !file && !saved;
    filename.textContent = file?.name ?? "";
    if (file) {
      const size = file.size < 1024 ? `${file.size} B` : file.size < 1024 ** 2 ? `${Math.round(file.size / 1024)} KiB` : imageSizeLabel(file.size);
      status.textContent = `${size} selected${saved ? " · Replaces saved file" : ""}`;
    } else status.textContent = "Your saved file will be used";
    remove.hidden = !file;
  };
  field.addEventListener("change", render);
  remove.addEventListener("click", () => {
    if (busy || owner.prepared) return;
    field.value = "";
    options.clear?.();
    render(); selectionChecklist(); field.focus();
  });
  render();
}
function releaseControls() {
  const saved = !!owner.prepared;
  el("new-release-inputs").hidden = saved;
  el("input-preflight").hidden = saved;
  el("release-saved").hidden = !saved;
  input("deploy").hidden = saved;
  el("application-approval").hidden = saved && !!owner.applicationApproval;
  if (saved && owner.applicationApproval) el("override-review").hidden = true;
  text("application-review-title", saved ? "Your saved runtime settings" : "Stack runtime settings");
  applicationOverview();
}
function applicationOverview() {
  if (!connection) return;
  const parent = el("application-summary"); parent.replaceChildren();
  const storages = summarizeStorage(connection);
  const containers = applicationContract(connection).containers;
  for (const container of containers) {
    const section = document.createElement("div"), values = document.createElement("dl");
    if (containers.length > 1) {
      const title = document.createElement("h4"); title.textContent = `Container: ${container.name}`; section.append(title);
    }
    const rows = [
      ...(container.execution.source === "image" ? [] : [
        ["Command override", JSON.stringify(container.execution.command)], ["Argument override", JSON.stringify(container.execution.args)],
      ]),
      ["Environment overrides", Object.keys(container.env).length ? `Added to or replaces values from the image: ${JSON.stringify(container.env)}` : "None configured. Use the environment from the image."],
      ["Storage inside this container", container.mounts.map(mount => {
        const storage = storages.find(storage => storage.name === mount.storage);
        return `${mount.path} — ${storage ? `${storage.typeLabel.toLowerCase()} “${storage.name}” (${imageSizeLabel(storage.capacityBytes)})` : mount.storage}`;
      }).join("; ") || "No storage mounts configured."],
      ["Private files this container can access", container.applicationResources.map(path => path.join("/")).join("; ") || "No private application files granted."],
      ["Declared container ports", (container.ports.map(port => `${port.name}: ${port.port}`).join("; ") || "None declared.") + " This does not determine public reachability or restrict outbound connections."],
      ["Application process identity", `Linux user ${container.uid}, group ${container.gid}${container.uid === 0 ? " (root user)." : " (non-root user)."}`],
      ["CPU and memory", container.resources ? `Requests: ${JSON.stringify(container.resources.requests)}; limits: ${JSON.stringify(container.resources.limits)}.` : "Uses the stack's default container CPU and memory settings. The VM's allocation is configured separately."],
    ];
    for (const [name, value] of rows) {
      const row = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd");
      term.textContent = name; detail.textContent = value; row.append(term, detail); values.append(row);
    }
    section.append(values); parent.append(section);
  }
}
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
    reportedCertificate: {
      version: api.manualTls.version, certificateDer: api.manualTls.certificateDer,
      certificateSha256: api.manualTls.certificateSha256, publicKeySha256: api.manualTls.publicKeySha256,
      notBefore: api.manualTls.notBefore, notAfter: api.manualTls.notAfter, provenance: api.manualTls.provenance,
    },
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
function offerRecoveryBackup(value: unknown) {
  const nextUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = el<HTMLAnchorElement>("recovery-download");
  link.href = nextUrl;
  el("recovery-backup").hidden = false;
  text("recovery-backup-status", recoveryUrl ? "The backup has been updated. Save the latest copy." : "Save this encrypted backup before closing the tab.");
  if (recoveryUrl) URL.revokeObjectURL(recoveryUrl);
  recoveryUrl = nextUrl;
}
function failure(error: unknown) {
  const notice = el("notice"); notice.hidden = false;
  notice.textContent = error instanceof Error ? error.message : "Verification or deployment stopped. No unverified fallback was used.";
  const deploymentInputs = el<HTMLFieldSetElement>("deployment-inputs");
  if (deploymentInputs.disabled && !completed.has("ready")) text("job-title", "Deployment paused");
  busy = false; input("deploy").disabled = !connected || !!owner.prepared;
  deploymentInputs.disabled = false;
  activePhase = undefined; renderSteps();
  if (currentReadiness) staleReadiness();
  else if (readinessChecking) {
    text("readiness-title", "Readiness check stopped");
    text("readiness-description", "No current readiness result was confirmed. Review the reported issue, then verify again to retry without changing your enrolled instance.");
    text("readiness-time", "The check stopped before a current guest response was available.");
  }
  readinessChecking = false;
  input("inspect").disabled = false;
  input("storage-recovery").disabled = !owner.finalPin || !owner.prepared;
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
  text("stack-name", "Deployment: " + connection.workload.metadata.name);
  text("destination", "Image storage: managed by this stack");
  text("configuration", JSON.stringify(connection, null, 2));
  const contract = applicationContract(connection);
  text("application-contract", JSON.stringify(contract, null, 2));
  const hasOverrides = contract.containers.some(container => container.execution.source === "override" || Object.keys(container.env).length > 0);
  el("override-review").hidden = !hasOverrides;
  const security = el("security-values"); security.replaceChildren();
  for (const [label, value] of [["Verified preparation instance", api.channel.pin], ["Expected final VM measurement", connection.workload.spec.guest?.measurement ?? "Calculated from the approved stack"]]) {
    const row = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd");
    term.textContent = label; detail.textContent = value; row.append(term, detail); security.append(row);
  }
  storageCards = summarizeStorage(connection);
  unconfirmedReadiness();
  el("volume-keys").replaceChildren(); el("resource-files").replaceChildren();
  for (const storage of connection.storages) {
    if (storage.spec.type !== "EncryptedBlock" || storage.spec.initialization !== "Never") continue;
    const alias = storageCards.find(card => card.resourceName === storage.metadata.name)!.name;
    const label = document.createElement("label"); label.textContent = `Existing encryption key for ${alias}`;
    const field = document.createElement("input"); field.type = "file"; field.id = "key-" + storage.metadata.name;
    label.htmlFor = field.id;
    const hint = document.createElement("p"); hint.className = "hint";
    hint.textContent = "Choose the original 32-byte disk key. This disk will not be initialized or reformatted. A new key cannot unlock existing data.";
    el("volume-keys").append(label, field, hint);
    fileSelection(field, `disk key for ${alias}`, { saved: () => !!owner.volumeKeys?.[storage.metadata.name] });
  }
  const keyPaths = new Set([connection.workload.spec.containers[0].imageKeyResource.join("/"),
    ...connection.storages.filter((s: any) => s.spec.type === "EncryptedBlock").map((s: any) => s.spec.keyResource.join("/"))]);
  for (const resource of connection.workload.spec.resources) {
    const path = resource.join("/"); if (keyPaths.has(path)) continue;
    const label = document.createElement("label"); label.textContent = `Private application file: ${path}`;
    const field = document.createElement("input"); field.type = "file"; field.id = "resource-" + path;
    label.htmlFor = field.id;
    const consumers = connection.workload.spec.containers.filter((container: any) => (container.applicationResources ?? []).some((route: string[]) => route.join("/") === path)).map((container: any) => container.name);
    const hint = document.createElement("p"); hint.className = "hint";
    hint.textContent = `Select the file this application expects (up to 2 MiB). ${consumers.length ? `Declared application access: ${consumers.join(", ")}.` : "Consumed inside the verified guest according to the approved settings."} Its contents are not displayed here.`;
    el("resource-files").append(label, field, hint);
    fileSelection(field, `application file for ${path}`, { saved: () => !!owner.resources?.[path] });
  }
  text("private-files-hint", "New disk keys are generated automatically in your browser. Any existing disk keys or application files requested below must be supplied by you; they are separate from any source-registry login or source-image decryption key.");
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
  releaseControls();
  selectionChecklist();
  input("storage-recovery").disabled = !owner.finalPin || !owner.prepared;
  el("storage-recovery-section").hidden = !owner.finalPin;
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
function requireManagedImageStore() {
  const store = connection.workload.spec.imageStore;
  if (!store || typeof store.endpoint !== "string" || typeof store.writeEndpoint !== "string" || typeof store.repository !== "string") {
    throw new Error("This stack does not provide managed image storage. Ask its administrator for a stack using the built-in image store.");
  }
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
  evidence(); text("final-status", "Final workload verified"); el("final-status").className = "badge verified";
  el("storage-recovery-section").hidden = false;
  return final!;
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
  input("inspect").disabled = true; input("storage-recovery").disabled = true;
  unconfirmedReadiness(true);
  const channel = final ?? await finalConnection();
  const deadline = Date.now() + 300_000;
  const encryptedStorage = storageCards.filter(storage => storage.type === "EncryptedBlock").map(storage => storage.name);
  progress("ready", "Checking workload and encrypted storage…");
  while (true) {
    const status = await (await request(channel, "/nebula/v1/bootstrap", "GET", undefined, owner.prepared.audience)).json();
    text("result", JSON.stringify(status, null, 2)); evidence();
    const helperResponse = await channel.request("/nebula/v1/supervisors", { headers: { Authorization: `Bearer ${await api.jwt(owner.prepared.audience)}` } });
    let clientsRunning = false;
    let report: SupervisorReport | undefined, source: "reported" | "unsupported" | "unavailable" = "unavailable";
    if (helperResponse.status === 200) {
      report = checkedSupervisors(await helperResponse.json()); source = "reported";
      text("supervisor-status", "Process supervision only; application readiness is unknown.\n" + JSON.stringify(report, null, 2));
      clientsRunning = storageClientsRunning(report, encryptedStorage);
    } else if (helperResponse.status === 404) {
      source = "unsupported";
      text("supervisor-status", "This release has no supervisor report. Bootstrap readiness does not prove application health.");
      clientsRunning = true;
    } else if (helperResponse.status === 503) text("supervisor-status", "Supervisor status is temporarily unavailable; startup cannot be reported complete.");
    else throw new Error("Owner-authenticated supervisor status is unavailable");
    const summary = showReadiness(status, report, source);
    if (clientsRunning && summary.data.ready) break;
    if (Date.now() >= deadline) throw new Error("Keys reached the verified VM. Startup is still pending; use Verify again for status.");
    await sleep(4000);
  }
  complete("ready");
  readinessChecking = false;
  text("job-title", "Keys delivered; encrypted storage unlocked"); text("job-description", "The final VM passed fresh attestation and accepted your owner keys. App startup is authorized; application health is checked separately.");
  el("inspect").hidden = false;
  input("inspect").disabled = false; input("storage-recovery").disabled = false;
}
el("deploy-form").addEventListener("submit", event => {
  event.preventDefault(); if (busy || !connected || owner.prepared) return; busy = true; input("deploy").disabled = true;
  el<HTMLFieldSetElement>("deployment-inputs").disabled = true;
  el("notice").hidden = true;
  text("job-title", "Checking your deployment inputs…");
  text("job-description", "Keep this tab open while your browser prepares the release.");
  el("job-title").focus();
  void (async () => {
    const archive = input("archive").files?.[0], registryMode = sourceMode() === "registry";
    if (!registryMode && (!archive || !archive.size || archive.size > imageLimits.maxBytes)) {
      throw new Error(`Choose one nonempty local image archive up to ${imageSizeLabel(imageLimits.maxBytes)}`);
    }
    if (registryMode) {
      registryReference(input("source-reference").value);
      if (!input("source-reviewed").checked) throw new Error("Review and approve the source registry and token-service hostname first");
      if (input("source-image-key").value && input("source-recovery").files?.length) throw new Error("Choose a source image key or its old recovery file, not both");
    }
    await approveApplication();
    requireManagedImageStore();
    owner.imageKey ??= hex(crypto.getRandomValues(new Uint8Array(32))); owner.volumeKeys ??= {};
    for (const storage of connection.storages) if (storage.spec.type === "EncryptedBlock") {
      const selected = (document.getElementById("key-" + storage.metadata.name) as HTMLInputElement | null)?.files?.[0];
      if (!selected && owner.volumeKeys[storage.metadata.name]) continue;
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
    selectionChecklist();
    let recoveryPassword = input("recovery-password").value;
    offerRecoveryBackup(await api.backup(recoveryPassword)); input("recovery-password").value = "";
    try {
    completed.clear();
    progress("encrypting", "Encrypting image locally in your browser…");
    if (!owner.encryptedImage) {
      if (owner.cipherCacheAttempt) await removeCipherCache({ id: owner.cipherCacheAttempt, manifestDigest: "" });
      owner.cipherCacheAttempt = "nebula-cipher-" + crypto.randomUUID(); await api.save();
    }
    const keyId = `kbs:///${connection.workload.spec.containers[0].imageKeyResource.join("/")}`;
    const encryptionProgress = (done: number, total: number) => progress("encrypting", registryMode ? `Verifying and encrypting source locally: ${imageSizeLabel(done)} (limit ${imageSizeLabel(total)})` : `Encrypting locally: ${imageSizeLabel(done)} / ${imageSizeLabel(total)} (${Math.floor(done * 100 / total)}%)`);
    let local: { image: LocalCipherImage; cache: CipherCache };
    if (registryMode) {
      const source = { reference: input("source-reference").value, credentials: {
          username: input("source-username").value, password: input("source-password").value,
          token: input("source-bearer").value, tokenServiceHost: input("source-token-host").value,
        } };
      let sourceKey: Uint8Array | undefined;
      try {
        const oldRecovery = input("source-recovery").files?.[0];
        if (oldRecovery) {
          if (oldRecovery.size > 16 * 1024 * 1024) throw new Error("The source recovery file is too large");
          sourceKey = await sourceKeyFromRecovery(await oldRecovery.text(), input("source-recovery-password").value);
        } else if (input("source-image-key").value) sourceKey = sourceImageKey(input("source-image-key").value);
        for (const field of ["source-password", "source-bearer", "source-image-key", "source-recovery-password"]) input(field).value = "";
        local = await prepareRegistryImage({ ...source, sourceKey }, api.registrySourceWasm, owner.imageKey, keyId, imageLimits, owner.encryptedImage,
          (path, method, body, headers) => request(api.channel, path, method, body, "nebula-browser", headers), encryptionProgress, owner.cipherCacheAttempt);
      } finally {
        sourceKey?.fill(0); source.credentials.password = ""; source.credentials.token = "";
        for (const field of ["source-password", "source-bearer", "source-image-key", "source-recovery-password"]) input(field).value = "";
      }
    } else {
      if (owner.encryptedImage?.source) throw new Error("Select the original registry source to resume this encrypted release");
      local = await prepareLocalImage(archive!, owner.imageKey, keyId, imageLimits, owner.encryptedImage, encryptionProgress, owner.cipherCacheAttempt);
    }
    owner.encryptedImage = local.cache; delete owner.cipherCacheAttempt; await api.save();
    offerRecoveryBackup(await api.backup(recoveryPassword));
    await uploadEncryptedImage(local.image, imageLimits,
      (path, method, body, headers) => request(api.channel, path, method, body, "nebula-browser", headers),
      (sent, total) => progress("encrypting", `Uploading encrypted layers: ${imageSizeLabel(sent)} / ${imageSizeLabel(total)} (${Math.floor(sent * 100 / total)}%)`));
    progress("encrypting", "Publishing your encrypted image…");
    await request(api.channel, "/nebula/v1/publish", "POST", JSON.stringify({
      applicationApproval: owner.applicationApproval }));
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
        releaseControls();
        complete("encrypting", "measuring");
        await removeCipherCache(owner.encryptedImage); delete owner.encryptedImage; await api.save(); break;
      }
    }
    await provision();
    } finally {
      if (owner.prepared || owner.finalPin) offerRecoveryBackup(await api.backup(recoveryPassword));
      recoveryPassword = "";
    }
  })().then(() => {
    busy = false;
    el<HTMLFieldSetElement>("deployment-inputs").disabled = false;
  }).catch(failure);
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
el("download-verification").addEventListener("click", verificationDownload(el("verification-download-status"), el<HTMLAnchorElement>("verification-download-retry"), evidence));
el("deploy-form").addEventListener("input", selectionChecklist);
el("deploy-form").addEventListener("change", () => { sourceControls(); selectionChecklist(); });
fileSelection(input("archive"), "image archive");
fileSelection(input("source-recovery"), "source recovery file", { clear: () => { input("source-recovery-password").value = ""; } });
sourceControls();
unconfirmedReadiness();
input("storage-recovery").disabled = true;
el("storage-recovery-section").hidden = true;
void connect().catch(failure);
