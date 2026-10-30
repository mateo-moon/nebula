# Confidential owner gateway

This small guest process gives an unmodified Trustee an instance identity.
It creates a fresh P-256 TLS key in guest memory and exposes only owner
administration and non-secret instance/storage status. TNG attests the
containing PodVM; the Trustee CLI then pins this inner TLS identity.

The gateway never exposes KBS resource consumption, authentication or
attestation routes. It forwards administration to the guest-local KBS, which
validates the owner's native JWT.

`bootstrap-status` first checks that JWT with Trustee, then reports local key
retrieval status and storage errors. Successful resource bodies are erased and
never returned. The public storage endpoint exposes only a fixed phase value.

Build from the repository root with
`docker build -f docker/confidential-runtime/Dockerfile -t confidential-runtime .`.
Use the resulting immutable image digest in the workload declaration.
