import { AttestedChannel, endpoint, hash, type AttestedFetch, type SnpIdentity } from "./transport";
import { newOwner, storedOwner, saveOwner, jwt, encryptedBackup, restoreBackup, type OwnerState } from "./owner";
import profiles from "./profiles.json";

declare global { interface Window { nebula: any } }
const status = (text: string) => {
  const output = document.getElementById("loader-status"); if (output) output.textContent = text;
};
const failure = (error: unknown) => {
  status(error instanceof Error ? error.message : "Verification failed");
  const recovery = document.getElementById("restore-form"); if (recovery) recovery.hidden = false;
};

/** Fetch every executable byte through the pinned attested channel. An ordinary
 * navigation to the target would throw away this guarantee. */
export async function verifiedAssets(channel: AttestedChannel) {
  const response = await channel.request("/ui/manifest.json");
  if (response.status !== 200) throw new Error("The attested UI manifest is unavailable");
  const manifest = await response.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== 3 ||
      manifest.assets.map((a: any) => a.path).sort().join() !== "/ui/app.js,/ui/index.html,/ui/style.css") throw new Error("Invalid attested UI manifest");
  const result = new Map<string, Uint8Array>();
  for (const asset of manifest.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid UI asset digest");
    const response = await channel.request(asset.path);
    if (response.status !== 200) throw new Error("An attested UI asset is unavailable");
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.length > 2 * 1024 * 1024 || await hash(raw) !== asset.sha256) throw new Error("Attested UI asset digest mismatch");
    result.set(asset.path, raw);
  }
  return result;
}

async function isolation(): Promise<boolean> {
  if (crossOriginIsolated) return true;
  if (!("serviceWorker" in navigator) || !isSecureContext) throw new Error("This browser needs a secure HTTPS loader origin and WebAssembly isolation support");
  await navigator.serviceWorker.register(new URL("./coi.js", location.href), { scope: "./", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  if (sessionStorage.getItem("nebula-isolation-reload")) throw new Error("Browser isolation is unavailable. Open this link in a browser that supports cross-origin isolation");
  sessionStorage.setItem("nebula-isolation-reload", "1"); location.reload(); return false;
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
  // Only the independent release origin supplies this SDK and profile list.
  const sdkUrl = new URL("./sdk/tng_wasm.js", location.href).href;
  const sdk: any = await import(/* @vite-ignore */ sdkUrl);
  await sdk.default(new URL("./sdk/tng_wasm_bg.wasm", location.href).href);
  const fetcher = sdk.fetch as AttestedFetch;
  let channel: AttestedChannel | undefined;
  for (const profile of profiles.profiles as { identity: SnpIdentity }[]) {
    try {
      const candidate = new AttestedChannel(fetcher, target, profile.identity, saved?.preparationPin);
      const response = await candidate.request("/nebula/v1/browser");
      if (response.status === 200) { channel = candidate; break; }
    } catch { /* No secret has been sent; try the next independently approved release. */ }
  }
  if (!channel) throw new Error("SNP, workload policy or enrolled instance verification failed. No owner credential or image was sent.");
  status("SNP and measured preparation workload verified. Loading its UI…");
  const assets = await verifiedAssets(channel);
  const owner: OwnerState = saved ?? await newOwner();
  if (saved?.preparationPin && saved.preparationPin !== channel.pin) throw new Error("The preparation instance changed");
  owner.preparationPin = channel.pin;
  owner.token ??= token; token = "";
  const bound = channel;
  Object.defineProperty(window, "nebula", { value: Object.freeze({
    target, discovery, channel: bound, owner, fetcher,
    save: () => saveOwner(target, owner), jwt: (audience: string, discovery = false) => jwt(owner, audience, discovery),
    backup: (password: string) => encryptedBackup(owner, password),
    finalChannel: (origin: string, identity: SnpIdentity, pin?: string) => new AttestedChannel(fetcher, origin, identity, pin),
  }), writable: false, configurable: false });
  const html = new DOMParser().parseFromString(new TextDecoder().decode(assets.get("/ui/index.html")), "text/html");
  if (html.querySelector("script, iframe, object, embed, base, link, meta[http-equiv]")) throw new Error("UI document contains an unlisted executable resource");
  const style = document.createElement("style"); style.textContent = new TextDecoder().decode(assets.get("/ui/style.css")); document.head.append(style);
  document.body.replaceChildren(...html.body.childNodes);
  const script = document.createElement("script");
  script.src = URL.createObjectURL(new Blob([assets.get("/ui/app.js")! as BlobPart], { type: "text/javascript" }));
  script.onload = () => URL.revokeObjectURL(script.src);
  document.body.append(script);
}
if (typeof document !== "undefined") {
  document.getElementById("restore-form")?.addEventListener("submit", event => {
    event.preventDefault();
    void (async () => {
      const file = (document.getElementById("restore-file") as HTMLInputElement).files?.[0];
      const password = document.getElementById("restore-password") as HTMLInputElement;
      if (!file || file.size > 16 * 1024 * 1024) throw new Error("Choose your encrypted recovery file");
      const owner = await restoreBackup(await file.text(), password.value); password.value = "";
      const target = endpoint(new URLSearchParams(location.hash.slice(1)).get("endpoint") ?? "");
      await saveOwner(target, owner); location.reload();
    })().catch(() => failure(new Error("Recovery failed. Check the file and password. Existing enrollment was preserved.")));
  });
  void start().catch(failure);
}
