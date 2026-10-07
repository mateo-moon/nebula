# The guest client is built against the same AL2023 userspace.
FROM public.ecr.aws/amazonlinux/amazonlinux@sha256:3552faf41b70d5b123fc33d4429a259baa2bcf9aa6ab15c70ad6da40fd63d247
RUN dnf --releasever=2023.12.20260930 install -y python3.12 python3.12-pip ca-certificates \
    && dnf clean all
COPY control/requirements.lock /app/requirements.lock
RUN python3.12 -m pip install --no-cache-dir --requirement /app/requirements.lock
COPY control/cloud.py control/controller.py control/kube.py /app/
COPY binaries/aws-trustee-bootstrap /usr/local/bin/aws-trustee-bootstrap
COPY release/core.json /usr/share/nebula/release.json
RUN ln -s /usr/bin/python3.12 /usr/local/bin/python3
ENV PYTHONDONTWRITEBYTECODE=1 AWS_EC2_METADATA_DISABLED=true
WORKDIR /app
USER 65532:65532
ENTRYPOINT ["python3.12", "/app/controller.py"]
