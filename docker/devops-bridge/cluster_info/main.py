"""
Cluster-info MCP server (#4) — provides tools for agents to query THIS cluster's
access details, configuration, and runbooks. Always accurate (configured from env,
can be extended to query live state).

Uses the official MCP Python SDK (FastMCP). Runs as a streamable-http server on :8080.
The docs-agent (or orchestrator) calls it via a RemoteMCPServer.

Env:
  CLUSTER_NAME      default kagent-e2e
  API_ENDPOINT      default the kagent-e2e NLB
  PORT              default 8080
"""
from __future__ import annotations

import json
import os

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("cluster-info")

CLUSTER_INFO = {
    "cluster_name": os.getenv("CLUSTER_NAME", "kagent-e2e"),
    "distribution": "k0s v1.31.8+k0s on AWS (CAPA / vendor-free)",
    "platform": "kagent 0.9.7 (CNCF Sandbox, Google ADK runtime)",
    "namespace": "kagent",
    "api_endpoint": os.getenv(
        "API_ENDPOINT",
        "https://default-kagent-e2e-apiserver-076a389403df031a.elb.eu-central-1.amazonaws.com:6443",
    ),
    "auth": "mTLS (kubeconfig client cert) + OIDC (Google via kubelogin, usernamePrefix oidc:)",
    "deploy": "export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt; pnpm synth && pnpm apply (from ~/Gig/kagent-poc)",
    "secrets": "SOPS (age) in .secrets/secrets.yaml; ref+sops:// resolved at synth via vals",
    "storage": "external ephemeral Postgres (kagent-pg, pgvector-enabled for agent memory)",
    "agents": [
        "devops-orchestrator (sonnet) — front door, routes, enforces propose-then-approve",
        "docs-agent (haiku) — cluster documentation, 'how to' questions",
        "k8s-inspector (haiku) — read-only cluster inspection",
        "change-author (sonnet) — drafts changes, gated mutations",
    ],
}


@mcp.tool()
def get_cluster_info() -> str:
    """Get this cluster's full configuration: access methods, API endpoint, deploy commands,
    agent topology, storage, secrets management, and RBAC. Use for any 'how is this cluster
    set up' or 'how do I access' question."""
    return json.dumps(CLUSTER_INFO, indent=2)


@mcp.tool()
def get_access_instructions(audience: str = "developer") -> str:
    """Get step-by-step access instructions. Pass audience='developer' for OIDC/Google SSO
    access, or audience='operator' for the bootstrap kubeconfig."""
    if audience == "operator":
        return (
            "## Operator Access (kagent-e2e)\n\n"
            "```bash\n"
            "export KUBECONFIG=~/.nebula/kagent-e2e/kubeconfig\n"
            "kubectl get nodes\n"
            "kubectl -n kagent get pods\n"
            "```\n\n"
            "This kubeconfig was written by `nebula bootstrap --provider aws --name kagent-e2e`.\n"
            "It uses mTLS (cluster-admin client cert)."
        )
    return (
        "## Developer Access (kagent-e2e)\n\n"
        "**Prerequisite:** install kubelogin (one time):\n"
        "```bash\n"
        "kubectl krew install oidc-login\n"
        "```\n\n"
        "**Connect:**\n"
        "1. Get `kubeconfig-dev.yaml` (from the repo or your team)\n"
        "2. Run:\n"
        "```bash\n"
        "KUBECONFIG=kubeconfig-dev.yaml kubectl get nodes\n"
        "```\n"
        "3. Browser opens → **Google login** → access granted\n\n"
        "You now have **view** access (read-only). For write access, ask the orchestrator agent.\n"
        "Tokens auto-refresh via kubelogin."
    )


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
