# Confidential agent

One measured guest service owns Nebula's confidential runtime. Its main entrypoint starts internal modules from public configuration bound by native CoCo genpolicy. HTTP requests cannot enable modules, choose native executables or change resource recipients.

The workload module combines owner authentication, instance identity, policy administration, provisioning readiness, attestation collateral and storage coordination. The agent installs the guest firewall and static application launcher, then permanently drops its HTTP process to UID/GID 10001 before listening. One private native child manages all declared encrypted volumes and explicitly delegated application resources. It retains only CHOWN, SYS_ADMIN and MKNOD; it cannot change the firewall or impersonate an application UID. It retrieves disk keys locally and never returns them to the HTTP process or application. Authenticated owner provisioning passes through the HTTP gateway, which erases its temporary request buffers after forwarding them to Trustee.

Frontend and ciphertext preparation are modules of the same entrypoint. Their measured configurations enable only the required module. The browser package contains static assets and local encryption code. Preparation receives ciphertext and registry push credentials, never image plaintext or its decryption key.

Production builds include only workload or browser modules (`NEBULA_AGENT_MODULES=workload|browser`). This keeps unused browser/publishing code out of the workload image and lets a reviewed browser release pin that image without embedding its own image digest. Both builds use the same main entrypoint and lifecycle.

The main service owns startup, shutdown and failure handling. A failed native module closes the public agent. An inherited private channel requests native shutdown after the HTTP process drops root; parent failure closes the same channel. Shutdown cancels preparation work and releases mount leases. Readiness uses the owner module's state directly; there is no separate polling daemon. Storage waits for owner readiness before starting CDH attestation.

The last TNG sidecar has a Kubernetes startup probe. The main agent returns success only after owner policies and all declared resources are available. This keeps kubelet from pulling the encrypted application before its key exists while TNG and Trustee accept owner enrollment. The probe permits one hour for provisioning; after that, recovery requires verifying a replacement guest. The application launcher also checks the private readiness marker before executing application code.

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

The agent exposes only owner administration and public diagnostics. KBS resource reads, authentication and attestation routes are excluded from its owner API. `bootstrap-status` checks native Trustee authorization before reporting resource availability; successful resource bodies are erased and never returned. The application broker enforces measured resource allowlists and Unix peer credentials, with image and volume keys explicitly excluded.
