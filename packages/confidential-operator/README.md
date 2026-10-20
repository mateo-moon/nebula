# Confidential workload operator

Install through Nebula's `ConfidentialOperator` construct and declare native
`ConfidentialWorkload` and `ConfidentialStorage` resources. See the
[module guide](../nebula/src/modules/k8s/confidential-workloads/README.md)
for storage and owner enrollment.

The controller renders the pinned official Trustee chart and runs native
genpolicy. It has namespaced access to the declarations, Pod and Service
creation, PVC reads and status updates. It has no Secret, exec, attach or
storage-deletion permissions.

Build the image from the repository root:

```sh
docker build -f docker/confidential-operator/Dockerfile -t confidential-operator .
```

Pin the published image digest when installing. The image reuses the qualified
Nebula synthesis toolchain; it does not build or publish Helm dependencies.
