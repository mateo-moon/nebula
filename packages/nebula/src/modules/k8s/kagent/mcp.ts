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
import { remoteMcp } from "./crd";

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
  });

  return name;
}
