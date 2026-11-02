# Build both architectures from a reviewed Debian digest. No host software is
# installed by this container; it only calls Kubernetes and AWS APIs.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-boto3 python3-yaml ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 rollout \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin rollout
USER 65532:65532
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python3", "-B", "/opt/rollout/runtime.py"]
