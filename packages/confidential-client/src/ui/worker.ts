import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deploy, type DeployOptions } from "../deploy";
import { TrusteeClient } from "../client";
import { renewClient } from "../prepare";

export function uiError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const choices: [RegExp, string][] = [
    [/abort|cancel/i, "Stopped locally. Your existing release and instance enrollment were preserved; retry the same release when ready."],
    [/token.*(match|commitment)|claim was refused/i, "The access token does not match this stack, or the instance has already been claimed."],
    [/Owner authorization failed|HTTP 403|HTTP 401/i, "Your owner key does not control this instance. No unverified fallback was attempted."],
    [/another image|another declaration|another.*digest/i, "This release slot already contains another image. The existing release was preserved."],
    [/entrypoint.*absolute/i, "Use a linux/amd64 image with an absolute executable path in its ENTRYPOINT or CMD."],
    [/linux\/amd64/i, "Select a local linux/amd64 image."],
    [/port.*in use/i, "A local verifier port is already in use. Close the other confidential client and retry."],
    [/Docker|docker/i, "The local Docker runtime is unavailable. Start it and retry this same release."],
    [/expired.*sign|signing chain/i, "The local verifier credentials expired. Use Verify again to renew them without changing the instance pin."],
    [/bootstrap did not reach ready/i, "Keys reached the verified instance, but startup is not ready yet. Use Verify again for status."],
    [/connection failed|discovery failed|attestation|endpoint.*reachable|startup timed out/i, "The attested connection could not be verified. Check the endpoint and public endorsement certificate, then retry. No unverified fallback was used."],
  ];
  return choices.find(([pattern]) => pattern.test(message))?.[1] ??
    "The operation stopped without relaxing verification. Your release was preserved; retry or inspect the private local diagnostic file.";
}

// Run expensive native operations outside the HTTP process. Secrets travel over
// the private IPC channel, never command arguments, stdout or a remote server.
process.once("message", async (input: { action: "deploy" | "inspect"; options: DeployOptions }) => {
  const options = input.options;
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.on("message", (event: any) => { if (event?.type === "cancel") cancel(); });
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    let result: unknown;
    if (input.action === "deploy") {
      result = await deploy({ ...options, signal: stop.signal, onProgress: phase => process.send?.({ type: "progress", phase }) });
    } else {
      const pointer = join(options.releaseDirectory, "active-state.json");
      let state = existsSync(pointer) ? JSON.parse(readFileSync(pointer, "utf8")).path : join(options.releaseDirectory, "owner-state");
      // Renewal preserves the enrolled certificate, identity and resource list.
      const next = join(options.releaseDirectory, `verifier-${Date.now()}`);
      state = await renewClient(state, next);
      writeFileSync(pointer, JSON.stringify({ path: state }) + "\n", { mode: 0o600 });
      const key = readFileSync(join(options.releaseDirectory, "owner.key"));
      let client: TrusteeClient | undefined;
      try {
        client = await TrusteeClient.connect({ stateDirectory: state, ownerPrivateKey: key,
          audience: JSON.parse(readFileSync(join(state, "instance.json"), "utf8")).audience, tngBinary: options.tngBinary, signal: stop.signal });
        const bootstrap: any = await client.bootstrapStatus(), storage = await client.storageStatus();
        const ready = bootstrap.phase !== "awaiting-configuration" &&
          Object.values(bootstrap.resources ?? {}).length > 0 &&
          Object.values(bootstrap.resources ?? {}).every((value: any) => value.status === 200) &&
          Object.values(storage.storage).every(value => value.phase === "ready");
        result = { verified: true, ready, instance: JSON.parse(readFileSync(join(state, "instance.json"), "utf8")).publicKeySha256,
          bootstrap, storage };
      } finally { key.fill(0); await client?.close(); }
    }
    process.send?.({ type: "result", result });
  } catch (error) {
    // Detailed errors may name local files. Keep them off the browser API.
    writeFileSync(join(options.releaseDirectory, "diagnostic.txt"), error instanceof Error ? error.message : "Operation failed", { mode: 0o600 });
    process.send?.({ type: "failure", error: uiError(error) });
  } finally {
    options.accessToken = undefined;
    process.disconnect?.();
  }
});
