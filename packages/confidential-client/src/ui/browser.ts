import type { StackSummary, UiJob, Upload } from "./protocol";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const token = new URLSearchParams(location.hash.slice(1)).get("session");
let stack: StackSummary | undefined, hasRelease = false, running = false;
const stages = ["encrypting", "measuring", "waiting", "attesting", "provisioning", "ready"];
const descriptions: Record<string, string> = {
  encrypting: "Encrypting your local image and uploading ciphertext.",
  published: "The encrypted image is published. Preparing independent measurements.",
  measuring: "Preparing the expected VM and workload policy locally.",
  waiting: "Waiting for the stack to pick up your published image automatically.",
  attesting: "Verifying the guest and establishing ownership before sending any key.",
  provisioning: "The instance is verified and owner-authorized. Provisioning its keys.",
  starting: "Waiting for the encrypted image and storage to start.",
  ready: "Your image and storage are running in the verified confidential instance.",
  checking: "Verifying the enrolled instance again and checking guest-local status.",
};
function notice(message?: string) {
  element("notice").hidden = !message;
  element("notice").textContent = message ?? "";
}
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "The local operation could not finish");
  return value;
}
function updateControls() {
  element<HTMLButtonElement>("deploy").disabled = !stack || running;
  element<HTMLInputElement>("connection").disabled = running;
  element<HTMLButtonElement>("inspect").disabled = running;
  element("inspect").hidden = !hasRelease;
  element("cancel").hidden = !running;
  element("access-token-group").hidden = hasRelease;
  element<HTMLInputElement>("access-token").required = !hasRelease;
  element<HTMLInputElement>("source-image").readOnly = hasRelease;
  element("deploy-label").textContent = hasRelease ? "Resume saved release" : "Encrypt & deploy";
  for (const input of document.querySelectorAll<HTMLInputElement>("#volume-keys input, #resource-files input")) {
    input.required = !hasRelease && input.dataset.required === "true";
  }
}
function fileInputs(id: string, fields: { name: string; required: boolean }[], kind: string) {
  const parent = element(id); parent.replaceChildren();
  for (const field of fields) {
    const label = document.createElement("label"); label.textContent = `${kind}: ${field.name}${field.required ? " (required)" : " (optional)"}`;
    const input = document.createElement("input"); input.type = "file"; input.dataset.name = field.name;
    input.dataset.required = String(field.required); input.required = field.required; label.append(input); parent.append(label);
  }
}
function showStack(value: StackSummary, saved: boolean) {
  stack = value; hasRelease = saved;
  element("stack").hidden = false;
  element("stack-name").textContent = value.name;
  element("endpoint").textContent = `${value.endpoint.host}:${value.endpoint.port}`;
  element("identity").textContent = JSON.stringify({ guest: value.identity, helpers: value.helperImages }, null, 2);
  element("image-contract").textContent = value.images.map(image => `${image.name}: ${image.command}; UID ${image.uid}; mounts ${image.mounts.map(m => m.path).join(", ") || "none"}; ports ${image.ports.map(p => p.port).join(", ") || "none"}`).join("\n");
  const chips = element("storage-summary"); chips.replaceChildren();
  for (const volume of value.volumes) { const chip = document.createElement("span"); chip.textContent = `${volume.name} · ${volume.type === "Memory" ? "memory" : "encrypted disk"}`; chips.append(chip); }
  fileInputs("volume-keys", value.volumes.filter(v => v.type === "EncryptedBlock").map(v => ({ name: v.name, required: v.keyRequired })), "Existing volume key");
  fileInputs("resource-files", value.resourceFiles.map(name => ({ name, required: true })), "Private application resource");
  element<HTMLInputElement>("reviewed").checked = false;
  updateControls();
}
function showJob(job?: UiJob) {
  running = job?.status === "running";
  if (!job) { updateControls(); return; }
  const verified = job.status === "succeeded" && job.result?.verified === true;
  const ready = verified && (job.action === "deploy" || job.result?.ready === true);
  let index = stages.indexOf(job.phase);
  if (job.phase === "published") index = 1;
  if (job.phase === "starting") index = 5;
  if (job.phase === "checking") index = 3;
  if (verified && !ready) index = 4;
  for (const item of document.querySelectorAll<HTMLElement>("#steps li")) {
    const position = stages.indexOf(item.dataset.phase!);
    item.classList.toggle("done", ready || position < index);
    item.classList.toggle("active", running && position === index);
  }
  element("verified").hidden = !verified;
  element("job-title").textContent = job.status === "failed" ? "Deployment needs attention" : ready ? "Verified and ready" : verified ? "Instance verified" : "Working on your deployment";
  element("job-description").textContent = job.status === "failed" ? job.error ?? "The operation stopped safely." : verified && !ready ?
    "Attestation passed. The workload or storage is not ready yet; review its status below." : descriptions[job.phase];
  if (job.status === "failed") notice(job.error);
  if (verified) {
    hasRelease = true;
    element("instance").textContent = `Instance: ${job.result?.instancePublicKeySha256 ?? job.result?.instance ?? "verified"}`;
    element("result").textContent = JSON.stringify(job.result, null, 2);
    element("result-details").hidden = false;
  }
  updateControls();
}
async function refreshImages() {
  try {
    const value = await api("/api/images");
    element("images").replaceChildren(...value.images.map((name: string) => { const option = document.createElement("option"); option.value = name; return option; }));
    element("image-hint").textContent = `${value.images.length} local images found. Choose a linux/amd64 image.`;
  } catch (error) { element("image-hint").textContent = (error as Error).message; }
}
async function uploadFiles(id: string): Promise<Upload[]> {
  return Promise.all([...document.querySelectorAll<HTMLInputElement>(`#${id} input[type=file]`)].filter(i => i.files?.length).map(async input => {
    const file = input.files![0];
    const base64 = await new Promise<string>((accept, reject) => {
      const reader = new FileReader(); reader.onerror = reject;
      reader.onload = () => accept(String(reader.result).split(",")[1]); reader.readAsDataURL(file);
    });
    return { name: input.dataset.name!, base64 };
  }));
}
element<HTMLInputElement>("connection").addEventListener("change", async event => {
  notice();
  try {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    const value = await api("/api/connection", { text: await file.text() });
    showStack(value.stack, value.hasRelease); showJob();
  } catch (error) { notice((error as Error).message); }
});
element("refresh-images").addEventListener("click", refreshImages);
element("deploy-form").addEventListener("submit", async event => {
  event.preventDefault(); notice(); running = true; updateControls();
  try {
    const registryAuth = element<HTMLInputElement>("registry-auth").files?.[0];
    const value = await api("/api/deploy", { sourceImage: element<HTMLInputElement>("source-image").value.trim(),
      accessToken: element<HTMLInputElement>("access-token").value.trim(), reviewed: element<HTMLInputElement>("reviewed").checked,
      ...(registryAuth ? { registryAuth: await registryAuth.text() } : {}),
      ...(element<HTMLInputElement>("registry-username").value || element<HTMLInputElement>("registry-password").value ? {
        registryUsername: element<HTMLInputElement>("registry-username").value,
        registryPassword: element<HTMLInputElement>("registry-password").value,
      } : {}),
      ...(element<HTMLInputElement>("aws-profile").value.trim() ? { awsProfile: element<HTMLInputElement>("aws-profile").value.trim() } : {}),
      volumeKeys: await uploadFiles("volume-keys"), resourceFiles: await uploadFiles("resource-files") });
    showJob(value.job);
  } catch (error) { running = false; notice((error as Error).message); updateControls(); }
  finally {
    element<HTMLInputElement>("access-token").value = "";
    element<HTMLInputElement>("registry-password").value = "";
    element<HTMLInputElement>("registry-username").value = "";
    for (const input of document.querySelectorAll<HTMLInputElement>("#deploy-form input[type=file]")) input.value = "";
  }
});
element("inspect").addEventListener("click", async () => {
  notice();
  try { showJob((await api("/api/inspect", {})).job); }
  catch (error) { notice((error as Error).message); }
});
element("cancel").addEventListener("click", async () => {
  try { await api("/api/cancel", {}); element("job-description").textContent = "Stopping safely and preserving this release…"; }
  catch (error) { notice((error as Error).message); }
});
async function refresh() {
  try {
    const value = await api("/api/context");
    if (!stack && value.stack) showStack(value.stack, value.hasRelease);
    hasRelease = value.hasRelease;
    if (!element<HTMLInputElement>("source-image").value && typeof value.sourceImage === "string") {
      element<HTMLInputElement>("source-image").value = value.sourceImage;
    }
    element("tools").textContent = value.tools.tng && value.tools.genpolicy ? "Native verification tools available." : "Qualified TNG or genpolicy is missing. Add them to PATH, or start the UI with --tng and --genpolicy.";
    showJob(value.job);
  } catch (error) { notice((error as Error).message); }
}
void refresh().then(refreshImages);
setInterval(() => { if (running) void refresh(); }, 1500);
