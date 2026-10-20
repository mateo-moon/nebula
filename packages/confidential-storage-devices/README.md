# Confidential storage devices

Namespace-scoped containerd NRI device helper for Nebula's
`ConfidentialStorageDevices` construct. It exposes the qualified SNP and
device-mapper control devices only to configured storage helpers. It does not
open disks, hold keys or authorize Trustee key release; native guest policy
enforces the approved device access.

The production binary has no built-in deployment names. The construct supplies
explicit namespace, runtime handler, generated Pod prefix and container bindings.
Requests outside that scope receive no device adjustment. Pod annotations
cannot change these grants.

Build from the repository root:

```sh
docker build --platform linux/amd64 \
  -f docker/confidential-storage-devices/Dockerfile \
  -t nebula-confidential-storage-devices .
```

The build runs the scope and NRI callback tests. Pin the published digest in
`ConfidentialStorageDevices.image`. Its host-side placement is plumbing, not
part of the owner's trust decision.
