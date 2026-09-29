# Shared image for the DevOps-agent bridges and comms bots.
# Build:  docker build -t devops-bridge:dev bridges/   (then push to ECR for AWS)
# Each bridge Deployment overrides the command, e.g.:
#   k8s_watch:      python -u /app/k8s_watch/main.py
#   alert_bridge:   uvicorn alert_bridge.main:app --host 0.0.0.0 --port 8080
#   telegram_bot:   python -u /app/telegram_bot/main.py
#   runner_rerun:   python -u -m runner_rerun.main
FROM python:3.12.13-slim

WORKDIR /app
ENV PYTHONPATH=/app

# Install deps first (layer cache).
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -c constraints.txt -r requirements.txt

# Shared A2A client.
COPY a2a_common.py ./

# Per-bridge entrypoints (added as each bridge is built; COPY only what exists).
# Phase 3:
COPY k8s_watch/ ./k8s_watch/
# Phase 4:
COPY telegram_bot/ ./telegram_bot/
# Phase 5:
COPY alert_bridge/ ./alert_bridge/
COPY github_bridge/ ./github_bridge/
COPY matrix_bridge/ ./matrix_bridge/
# Cluster-info MCP (#4):
COPY cluster_info/ ./cluster_info/
# Rerun of CI jobs lost with their runner:
COPY runner_rerun/ ./runner_rerun/

# Non-root (M10): the bridges don't need root; run as a dedicated uid.
RUN useradd -r -u 10001 -m app && chown -R app /app
USER 10001

# Override per Deployment. Default prints usage so a misconfigured pod fails loudly.
CMD ["python", "-c", "import sys; sys.exit('no bridge entrypoint set — set command/args')"]
