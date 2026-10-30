# Confidential storage runtime

Guest-side encrypted storage for Nebula's `ConfidentialStorage` and
`ConfidentialWorkload` resources. The controller renders its configuration into
native genpolicy; applications do not configure the helper themselves.

The helper obtains a random 32-byte volume key from guest-local CDH after owner
enrollment and provisioning. It opens a fixed raw block device as LUKS2/ext4
and gives each approved application a directory through a UID/GID-authenticated
mount lease. The static launcher drops all application capabilities. Keys never
enter Kubernetes, the host device helper, command arguments or persistent files.

`IfEmpty` permits formatting only after checking the entire device is zero.
`Never` only opens existing disks. Wrong keys and malformed or unsupported LUKS
headers cause refusal. Inspection and unlock use the same sealed header copy,
so changing the backing header between those operations cannot bypass checks.

The binary exposes three measured entry points:

- `install`: copy the static launcher to guest tmpfs.
- `serve CONFIG`: retrieve the local key, open the disk and serve mount leases.
- `launch CONFIG -- /absolute/program ...`: receive mounts and start the application.

There is no hardware-derived fallback key, tool-node-specific launcher or
external bootstrap Trustee. The existing disk marker and device paths are kept
for data compatibility. LUKS-XTS does not prevent ciphertext rollback or provide
general integrity protection.

Build from the repository root:

```sh
docker build --platform linux/amd64 -f docker/confidential-storage/Dockerfile \
  -t nebula-confidential-storage .
```

The build runs Linux unit tests. The `test` target also supports unprivileged
cryptsetup tests on disposable files; it needs no host devices or privileged
container:

```sh
docker build --platform linux/amd64 --target test \
  -f docker/confidential-storage/Dockerfile -t nebula-storage-tests .
docker run --rm --network none --cap-drop ALL --read-only \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m nebula-storage-tests
```

Pin the published runtime image by digest in `spec.storageImage`.
Changing it changes the measured workload and requires a reviewed replacement
and fresh owner enrollment. See the [module documentation](../nebula/src/modules/k8s/confidential-workloads/README.md).
