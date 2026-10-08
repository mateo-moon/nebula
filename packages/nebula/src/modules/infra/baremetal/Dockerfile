# Supply a reviewed Debian base by digest. No installer runs in this container;
# all host access uses unprivileged OpenSSH and Kubernetes HTTPS.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml openssh-client ca-certificates passwd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 provisioner \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin provisioner
USER 65532:65532
ENV PYTHONDONTWRITEBYTECODE=1
# Sources are mounted from the versioned Nebula construct's ConfigMap.
ENTRYPOINT ["python3", "-B", "/opt/provisioner/controller.py"]
