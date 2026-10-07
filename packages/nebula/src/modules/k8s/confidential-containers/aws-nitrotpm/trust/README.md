# Public hardware trust roots

`aws-nitro-root-g1.crt` is the AWS Nitro root used for NitroTPM COSE evidence.
`amd-milan-ark.pem` is AMD's public Milan ARK, distributed in the pinned
`sev` 7.1.0 crate (`src/certs/snp/builtin/milan/ark.pem`). These files contain
public certificates, never private keys. The verifier compiles both roots into
the executable; neither management configuration nor environment variables can
replace them.

The image release build obtains the Milan ASVK chain from AMD's
`https://kdsintf.amd.com/vlek/v1/Milan/cert_chain` and checks it against this ARK.
ASVK/VLEK intermediates do not become additional trust roots.

References:
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html
- https://github.com/virtee/sev/tree/v7.1.0/src/certs/snp/builtin/milan
