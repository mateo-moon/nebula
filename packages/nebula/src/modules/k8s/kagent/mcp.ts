/**
 * Self-hosted MCP servers the agents call.
 *
 * github-mcp: the official github-mcp-server run in-cluster with a PAT (deterministic headless
 * auth — the remote api.githubcopilot.com endpoint is OAuth-first). Declared as a plain
 * Deployment exposing an SSE/streamable endpoint + a kagent `RemoteMCPServer` (the verified
 * v1alpha2 shape) that `change-author` references. Issues = the canonical task store.
 *
 * NOT wired into main.ts by default — call `declareGithubMcp(...)` and pass the returned name
 * to `declareAgents({ githubMcp })`. The exact github-mcp-server HTTP/SSE invocation is marked
 * VERIFY (confirm against `docker run ghcr.io/github/github-mcp-server --help` at deploy time).
 */
import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { KAGENT_WAVE, remoteMcp } from "./crd";
import { DEFAULT_BRIDGE_IMAGE } from "./bridges";

export interface GithubMcpConfig {
  /** github-mcp-server image (default ghcr.io/github/github-mcp-server:latest). */
  image?: string;
  /** GitHub PAT — placeholder here; prod from SOPS+AWS-KMS. */
  token?: string;
  /** Toolsets to enable (default "repos,issues,pull_requests"). */
  toolsets?: string;
  /** Server entrypoint args (VERIFY for this image — HTTP/SSE transport). */
  args?: string[];
  /** Listening port (default 8080). */
  port?: number;
}

/** The RemoteMCPServer name agents reference this server by. */
export const GITHUB_MCP = "github-mcp";

/**
 * Declare the github-mcp Deployment + Service + RemoteMCPServer. Returns the RemoteMCPServer
 * name (`github-mcp`) for agent wiring.
 */
export function declareGithubMcp(
  scope: Construct,
  ns: string,
  cfg: GithubMcpConfig = {},
): string {
  const name = GITHUB_MCP;
  const image = cfg.image ?? "ghcr.io/github/github-mcp-server:latest";
  const port = cfg.port ?? 8080;
  const toolsets = cfg.toolsets ?? "repos,issues,pull_requests";

  new ApiObject(scope, "github-mcp-secret", {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "github-mcp-secrets", namespace: ns },
    type: "Opaque",
    stringData: {
      GITHUB_PERSONAL_ACCESS_TOKEN: cfg.token ?? "",
      GITHUB_TOOLSETS: toolsets,
    },
  });

  new ApiObject(scope, "github-mcp-deploy", {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "mcp",
              image,
              // VERIFY: github-mcp-server's HTTP/SSE invocation (recent versions: a
              // `--transport sse`/`server` mode). Confirm with `docker run <img> --help`.
              args: cfg.args ?? ["--transport", "sse", "--port", String(port)],
              env: [
                { name: "GITHUB_PERSONAL_ACCESS_TOKEN", valueFrom: { secretKeyRef: { name: "github-mcp-secrets", key: "GITHUB_PERSONAL_ACCESS_TOKEN" } } },
                { name: "GITHUB_TOOLSETS", valueFrom: { secretKeyRef: { name: "github-mcp-secrets", key: "GITHUB_TOOLSETS" } } },
              ],
              ports: [{ containerPort: port }],
            },
          ],
        },
      },
    },
  });

  new ApiObject(scope, "github-mcp-svc", {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns },
    spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port, targetPort: port }] },
  });

  remoteMcp(scope, "github-mcp-server", {
    name,
    namespace: ns,
    description: "Self-hosted github-mcp-server (PAT auth) — repos/issues/pull_requests.",
    protocol: "SSE",
    url: `http://${name}.${ns}:${port}/sse`,
    timeout: "60s",
    sseReadTimeout: "5m",
    // Apply before the Agents that reference this server (so they are Accepted first-try).
    syncWave: KAGENT_WAVE.DEPENDENCY,
  });

  return name;
}

// ── cluster-info MCP (#4) ─────────────────────────────────────────────────────
//
// The cluster-info MCP server (docker/devops-bridge/cluster_info/main.py) gives
// agents a tool to query THIS cluster's access method, API endpoint, agent topology,
// and step-by-step access instructions. It's baked into the shared devops-bridge
// image (the Dockerfile COPYs cluster_info/) but runs here as a STANDALONE MCP
// server — NOT as a bridge — driven by the official MCP Python SDK (FastMCP) in
// streamable-http mode. The docs-agent references it so its answers come from the
// live server (always accurate, configurable via env) rather than a frozen prompt.

export interface ClusterInfoMcpConfig {
  /** Image bundling cluster_info/main.py (default: the shared devops-bridge image). */
  image?: string;
  /** Cluster name surfaced by get_cluster_info (env CLUSTER_NAME; defaults to the server's
   *  built-in default if unset — pass the real cluster name for portability). */
  clusterName?: string;
  /** API endpoint surfaced by get_cluster_info (env API_ENDPOINT; optional). */
  apiEndpoint?: string;
  /** Listening port (default 8080 — the FastMCP streamable-http port). */
  port?: number;
}

/** The RemoteMCPServer name agents reference this server by. */
export const CLUSTER_INFO_MCP = "cluster-info";

/**
 * Declare the cluster-info MCP Deployment + Service + RemoteMCPServer. Returns the
 * RemoteMCPServer name (`cluster-info`) for agent wiring — pass it to
 * `declareAgents({ clusterInfoMcp })` so the docs-agent can call get_cluster_info /
 * get_access_instructions.
 *
 * The server is stateless + tokenless, so it's safe to deploy unconditionally
 * (unlike the bridges, it won't crash-loop on a missing secret).
 */
export function declareClusterInfoMcp(
  scope: Construct,
  ns: string,
  cfg: ClusterInfoMcpConfig = {},
): string {
  const name = CLUSTER_INFO_MCP;
  const image = cfg.image ?? DEFAULT_BRIDGE_IMAGE;
  const port = cfg.port ?? 8080;

  // Env for main.py: PORT (listen port) + the optional cluster specifics it surfaces.
  const env: { name: string; value: string }[] = [{ name: "PORT", value: String(port) }];
  if (cfg.clusterName) env.push({ name: "CLUSTER_NAME", value: cfg.clusterName });
  if (cfg.apiEndpoint) env.push({ name: "API_ENDPOINT", value: cfg.apiEndpoint });

  new ApiObject(scope, "cluster-info-mcp-deploy", {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "mcp",
              image,
              imagePullPolicy: "IfNotPresent",
              // FastMCP streamable-http server. main.py's __main__ block calls
              // mcp.run(transport="streamable-http", host="0.0.0.0", port=PORT).
              // Matches the bridges.ts entrypoint convention (full cmd in args;
              // the devops-bridge image has no ENTRYPOINT).
              args: ["python", "-u", "/app/cluster_info/main.py"],
              env,
              ports: [{ containerPort: port }],
            },
          ],
        },
      },
    },
  });

  new ApiObject(scope, "cluster-info-mcp-svc", {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns },
    spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port, targetPort: port }] },
  });

  remoteMcp(scope, "cluster-info-mcp-server", {
    name,
    namespace: ns,
    description:
      "Cluster-info MCP — get_cluster_info + get_access_instructions for THIS cluster.",
    // FastMCP streamable-http mounts its endpoint at /mcp by default
    // (MCP Python SDK: SSE→/sse, streamable-http→/mcp).
    protocol: "STREAMABLE_HTTP",
    url: `http://${name}.${ns}:${port}/mcp`,
    timeout: "30s",
    // Apply before the docs-agent that references this server (so it is Accepted first-try).
    syncWave: KAGENT_WAVE.DEPENDENCY,
  });

  return name;
}
