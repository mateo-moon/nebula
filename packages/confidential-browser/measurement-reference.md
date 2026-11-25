# Where the VM measurement comes from

The **Expected VM launch measurement** is the approved starting state of the confidential VM, represented by 96 hexadecimal characters. It is a 48-byte SNP launch digest. The certificate checker compares the value in AMD's signed report with this expected value.

The prefilled value comes from a release profile bundled with the UI. It is a manually published reference: the page does not calculate it from the running guest or adopt the value in that guest's report. Obtain your expected reference from a release or review you independently trust before entering secrets.

## The configuration behind the current reference

The documented dev frontend and preparation guests use these inputs:

| Input | Source and value |
| --- | --- |
| Guest runtime | Official [Kata 4.3.1 release](https://github.com/kata-containers/kata-containers/releases/tag/4.3.1), with the installer and boot files pinned by digest |
| Guest kernel | Release file `vmlinuz-6.18.56-208`; SHA-256 `3432f6a4fe359ce7984181ef95b74afbce5fd69d9c5db2ac526a81d5ed3dc387` |
| SNP boot firmware | Release file `AMDSEV.fd`; SHA-256 `d9bbf4c9279c89e4dfc7b90d8a1d42440bc9b8022a9cdb86ab4d5449b51892a7` |
| Virtual CPU | `EPYC-v4`, two vCPUs, guest features `1` |
| Initrd | None |
| Kernel command line | Kata defaults, guest-root-filesystem dm-verity parameters and Nebula's guest-agent parameters; the exact string is in the [public calculation record](qualification/snp-launch-2026-11-12.json) |

The administrator deploys the pinned Kata runtime. Its [upstream SNP configuration](https://github.com/kata-containers/kata-containers/blob/03cf2ec06a5d302f23af811744f6bcea49988bfb/src/runtime/config/configuration-qemu-snp.toml.in) supplies the runtime defaults. The deployment selects the boot files under its installation prefix. Nebula's [browser Pod declaration](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/nebula/src/modules/k8s/confidential-workloads/browser.ts#L99-L104) selects `kata-qemu-snp`, sets two vCPUs and adds the guest-agent kernel parameters.

During release qualification, the resulting QEMU launch arguments were recorded and the public boot-file hashes were checked against the official release. Pinned [sev-snp-measure](https://github.com/virtee/sev-snp-measure/blob/8f2b337e38bc83f87cd30f3253cdfe8e3e12cc3a/README.md#programmatic-usage) then calculated the expected digest offline from those inputs. It is the SNP launch-measurement algorithm, not a SHA-256 hash of the configuration file. The [AMD SNP ABI specification](https://www.amd.com/content/dam/amd/en/documents/developer/56860.pdf) defines the report's `MEASUREMENT` field.

The calculation for this two-vCPU configuration produced:

```text
e17cb86d23c57635b2fa4540bc44c411c2ef7b1836ad9fb05906f57d3692292c32645a61e913e80b618abc1d40f54149
```

The calculation record contains the pinned calculator revision, release archive checksum, boot-file hashes and complete kernel command line. It documents the existing calculation; publishing it does not constitute a new attestation test. Other boot inputs or vCPU states require their own calculated and reviewed reference.

## How that value reaches the field

1. A maintainer manually copies the qualified result into the release's `identity.measurement`. The current boot reference was first added in [commit 497063c9](https://github.com/mateo-moon/nebula/commit/497063c9bc518a415792d6dbdee3443d057fbc37); the [reviewed profile](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/confidential-browser/src/loader/profiles.json#L4-L18) retains it.
2. The [browser build](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/confidential-browser/src/build.ts#L26-L30) bundles that profile into the loader's JavaScript.
3. The [loader](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/confidential-browser/src/loader/main.ts#L93-L96) passes the first release profile's identity to the certificate form.
4. The [form code](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/confidential-browser/src/loader/manual.ts#L72-L93) copies `hardware.measurement` into `tls-measurement`. When you submit the checker, your field value becomes the expected measurement in the [verification policy](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/confidential-browser/src/loader/transport.ts#L23-L45).

Frontend and preparation share this boot measurement because their documented boot inputs and vCPU configuration match. Their container images and workload policies differ. There is currently no automatic node-to-UI reference-generation pipeline.

## What else must match

The adjacent **Expected workload-policy digest** is a separate 64-character SHA-256 value. Use the frontend's Init-Data digest from its independently reviewed [native genpolicy deployment plan](https://github.com/mateo-moon/nebula/blob/1d2fcc271299f01a24172804fcc3dff82ab90401/packages/nebula/src/modules/k8s/confidential-workloads/browser.ts#L125-L145). It binds the workload configuration and agent policy through `HOST_DATA` / `init_data`; it is not the VM measurement, certificate fingerprint or raw Rego-file hash. Preparation and final guests have their own workload-policy bindings. See the [native genpolicy build guide](../../tools/genpolicy/README.md) and [binding and administrator-isolation details](../nebula/src/modules/k8s/trustee/README.md#administrator-isolation).

Both measurements, the required platform policy and the certificate's public-key binding must pass. Follow the [certificate-checking instructions](README.md#check-the-browsers-certificate) with a verifier obtained through the [reviewed native TNG build process](../../tools/tng-client/README.md). The page's checker remains a convenience; the page's own reference values do not independently authenticate its JavaScript.

The older [snp-launch.json](qualification/snp-launch.json) records the previous guest-kernel configuration. It supports historical release review and is not the source of the current `e17…` reference.
