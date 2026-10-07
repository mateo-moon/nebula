# Test runtime only: no host TPM, AWS credentials or production key material.
# Match the isolated software-TPM job and retain container confinement.
FROM ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      swtpm tpm2-tools libtss2-tcti-swtpm0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
