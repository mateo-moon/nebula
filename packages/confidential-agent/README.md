# Confidential agent

One measured guest service owns Nebula's confidential runtime. Its main entrypoint starts internal modules from public configuration bound by native CoCo genpolicy. HTTP requests cannot enable modules, choose native executables or change resource recipients.

The workload module combines owner authentication, instance identity, policy administration, provisioning readiness, attestation collateral and storage coordination. The agent installs the guest firewall and static application launcher, then permanently drops its HTTP process to UID/GID 10001 before listening. One private native child manages all declared encrypted volumes and explicitly delegated application resources. It retains only CHOWN, SYS_ADMIN and MKNOD; it cannot change the firewall or impersonate an application UID. It retrieves disk keys locally and never returns them to the HTTP process or application. Authenticated owner provisioning passes through the HTTP gateway, which erases its temporary request buffers after forwarding them to Trustee.

Frontend and ciphertext preparation are modules of the same entrypoint. Their measured configurations enable only the required module. The browser package contains static assets and local encryption code. Preparation receives ciphertext and registry push credentials, never image plaintext or its decryption key.

Production builds include only workload or browser modules (`NEBULA_AGENT_MODULES=workload|browser`). This keeps unused browser/publishing code out of the workload image and lets a reviewed browser release pin that image without embedding its own image digest. Both builds use the same main entrypoint and lifecycle.

The main service owns startup, shutdown and failure handling. Loss of the native module closes the public agent. An inherited private channel requests native shutdown after the HTTP process drops root; parent failure closes the same channel. Shutdown cancels preparation work and releases mount leases. Readiness uses the owner module's state directly; there is no separate polling daemon. Storage waits for owner readiness before starting CDH attestation.

A blocked volume keeps the owner control plane available for status and explicit recovery. Recovery is bound to the enrolled instance, exact sealed header and a one-use expiring challenge. It can initialize only a verified empty ciphertext payload; nonzero or ambiguous data is preserved for manual recovery. Journaled initialization resumes without formatting existing data or changing ownership of existing recipient directories.

The static launcher remains PID1 in its own native-policy-enforced namespace. It holds the original authenticated mount leases and supervises only capability-free application children. Before restarting a child, it terminates and reaps every descendant. Lease loss, an unreapable descendant or trusted-launcher failure stops the application. Native create-once and lease-use latches are never reset. Supervisor status reports process state and restart counts; a running process alone does not establish application health.

A regular Kubernetes init stage runs the same agent's `owner-gate` module after TNG and Trustee start. It has no capabilities or listeners and reads only the guest-memory readiness marker. It can wait indefinitely for owner policies and all declared resources without killing a healthy attestation sidecar. Kubelet pulls the encrypted application after this stage exits. The application launcher independently checks the private readiness marker before executing application code.

Before opening owner access, the unified agent obtains its public SNP report from fixed guest-loopback AA and prepares one bounded public VCEK in dedicated guest memory. Certificate downloads use only the AMD URL derived from that report; an embedded public VCEK can avoid the download. Publication is atomic, restart reuse is bound to the exact chip/TCB URL, and failed preparation keeps startup closed. Native KBS reads this volume read-only through `OfflineStore`, without a network fallback, and still performs all AMD chain, signature, chip, TCB and policy verification. The cache provides public collateral, never attestation authority or workload keys. Applications and legacy layouts do not receive the volume.

Upstream TNG and the unmodified Trustee remain separate components in the measured Pod. The Kubernetes operator stays outside the guest. Application launchers retain their UID, capability and mount boundaries.

Build and test from the repository root:

```sh
pnpm --dir packages/confidential-agent install --frozen-lockfile
pnpm --dir packages/confidential-agent typecheck
pnpm --dir packages/confidential-agent build
pnpm --dir packages/confidential-agent test
docker build -f docker/confidential-agent/Dockerfile -t confidential-agent .
```

Use the resulting immutable digest as `ConfidentialWorkload.spec.agentImage`. The official Trustee chart and TNG remain separately pinned. `storageImage` and `trustee.gatewayImage` preserve previously enrolled layouts. A changed measured guest requires owner verification and enrollment of its replacement.

The agent exposes owner administration and fixed public readiness and identity routes. KBS resource reads, authentication and attestation routes are excluded from its owner API. `bootstrap-status` checks native Trustee authorization before reporting resource availability; successful resource bodies are erased and never returned. The application broker enforces measured resource allowlists and Unix peer credentials, with image and volume keys explicitly excluded.

Unified workload layouts capture KBS warnings and errors in its existing private guest-memory temporary volume. Only the trusted agent receives that volume, read-only; applications never mount it. The enrolled owner's `diagnostics` command reads `/nebula/v1/diagnostics` and returns fixed category counters from at most the newest 64 KiB and 512 complete log lines. Raw log text, request bodies, JWTs, keys and file errors are never returned. Missing or invalid private files report unavailable. Counts describe observed lines in that window, may overlap, and do not establish attestation success. Native exec and guest file streaming remain disabled. Legacy layouts and standalone Trustee logging remain unchanged.
