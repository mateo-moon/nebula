/**
 * Thin typed builders for kagent `kagent.dev` custom resources (Agent, ModelConfig,
 * RemoteMCPServer, MCPServer) on top of raw cdk8s `ApiObject`s.
 *
 * The Nebula `Kagent` module only installs the platform (controller + UI + Postgres);
 * these helpers author the app-level CRs. cdk8s renders object keys alphabetically, so
 * field order in the builders does not affect the synthesised YAML.
 *
 * Verified against kagent 0.9.7 (kagent.dev/docs/resources/api-ref + the chart-created
 * defaults in dist/). Field names flagged // VERIFY below need a live `kubectl get … -o
 * yaml` confirmation before first apply.
 */
import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";

export const KAGENT_API_GROUP = "kagent.dev";
export const KAGENT_API = "kagent.dev/v1alpha2";

// ── tools[] entries (shared by Agent.declarative.tools) ───────────────────────

export interface AgentToolTarget {
  apiGroup: string;
  kind: string;
  name: string;
  namespace: string;
}

export interface McpServerTool {
  apiGroup: string;
  kind: string; // "RemoteMCPServer" (v1alpha2) | "MCPServer" (v1alpha1)
  name: string;
  namespace?: string;
  toolNames?: string[];
  /** Tools that must be human-approved (HITL Approve/Reject) before they execute.
   *  This is the propose-then-approve safety gate for every mutation tool. */
  requireApproval?: string[];
  allowedHeaders?: string[];
}

export type AgentToolEntry =
  | { type: "Agent"; agent: AgentToolTarget }
  | { type: "McpServer"; mcpServer: McpServerTool };

/** A tools[] entry that delegates to another kagent Agent (agent-to-agent / A2A). */
export function agentTool(name: string, namespace: string): AgentToolEntry {
  return {
    type: "Agent",
    agent: { apiGroup: KAGENT_API_GROUP, kind: "Agent", name, namespace },
  };
}

/** A tools[] entry exposing an MCP server's toolset. `requireApproval` lists tools that
 *  must be human-approved before they run — the propose-then-approve gate. */
export function mcpTool(
  name: string,
  opts: {
    namespace?: string;
    kind?: "RemoteMCPServer" | "MCPServer";
    toolNames?: string[];
    requireApproval?: string[];
    allowedHeaders?: string[];
  } = {},
): AgentToolEntry {
  const mcp: McpServerTool = {
    apiGroup: KAGENT_API_GROUP,
    kind: opts.kind ?? "RemoteMCPServer",
    name,
  };
  if (opts.namespace) mcp.namespace = opts.namespace;
  if (opts.toolNames) mcp.toolNames = opts.toolNames;
  if (opts.requireApproval) mcp.requireApproval = opts.requireApproval;
  if (opts.allowedHeaders) mcp.allowedHeaders = opts.allowedHeaders;
  return { type: "McpServer", mcpServer: mcp };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export interface DefineAgentOptions {
  name: string;
  namespace: string;
  description: string;
  modelConfig: string;
  systemMessage?: string;
  tools?: AgentToolEntry[];
  /** Stream model responses (default true). */
  stream?: boolean;
  /** Declarative (kagent builds from prompt+tools+model) or BYO (you ship a container). */
  type?: "Declarative" | "BYO";
  /** Long-term vector memory (requires database.postgres.vectorEnabled). */
  memory?: { modelConfig: string; ttlDays?: number };
  /** Source the systemMessage from a ConfigMap/Secret (updatable without re-dedeploying the Agent). */
  systemMessageFrom?: {
    configMapRef?: { name: string; key: string };
    secretRef?: { name: string; key: string };
  };
  /** Pod deployment overrides (volumes, volumeMounts, env — reconciled by kagent into the harness Deployment). */
  deployment?: Record<string, unknown>;
}

/** Author a kagent `Agent` (Declarative by default). */
export function defineAgent(
  scope: Construct,
  id: string,
  opts: DefineAgentOptions,
): ApiObject {
  const declarative: Record<string, unknown> = {
    modelConfig: opts.modelConfig,
  };
  // systemMessage inline OR from a ConfigMap/Secret reference (mutually exclusive).
  if (opts.systemMessageFrom) {
    declarative.systemMessageFrom = opts.systemMessageFrom;
  } else {
    declarative.systemMessage = opts.systemMessage;
  }
  if (opts.stream !== false) declarative.stream = true;
  if (opts.tools && opts.tools.length > 0) declarative.tools = opts.tools;
  if (opts.memory) {
    declarative.memory = {
      modelConfig: opts.memory.modelConfig,
      ...(opts.memory.ttlDays ? { ttlDays: opts.memory.ttlDays } : {}),
    };
  }
  if (opts.deployment) {
    declarative.deployment = opts.deployment;
  }

  return new ApiObject(scope, id, {
    apiVersion: KAGENT_API,
    kind: "Agent",
    metadata: { name: opts.name, namespace: opts.namespace },
    spec: {
      type: opts.type ?? "Declarative",
      description: opts.description,
      declarative,
    },
  });
}

// ── ModelConfig ───────────────────────────────────────────────────────────────

export interface ModelConfigOptions {
  name: string;
  namespace: string;
  provider: string; // "Anthropic" | "OpenAI" | "Ollama" | "Gemini" | ...
  model: string; // e.g. "claude-sonnet-4-6"
  /** Secret holding the provider key. */
  apiKeySecret: string;
  /** Key inside that Secret (e.g. "ANTHROPIC_API_KEY"). */
  apiKeySecretKey?: string;
}

/**
 * Author a kagent `ModelConfig`. Field names mirror the chart-created
 * `default-model-config` (apiKeySecret + apiKeySecretKey). // VERIFY against a live
 * `kubectl get modelconfig default-model-config -o yaml` before first custom apply.
 */
export function modelConfig(
  scope: Construct,
  id: string,
  opts: ModelConfigOptions,
): ApiObject {
  const spec: Record<string, unknown> = {
    provider: opts.provider,
    model: opts.model,
    apiKeySecret: opts.apiKeySecret,
  };
  if (opts.apiKeySecretKey) spec.apiKeySecretKey = opts.apiKeySecretKey;
  return new ApiObject(scope, id, {
    apiVersion: KAGENT_API,
    kind: "ModelConfig",
    metadata: { name: opts.name, namespace: opts.namespace },
    spec,
  });
}

// ── RemoteMCPServer (remote HTTP/SSE MCP server the agent calls) ───────────────

export interface RemoteMcpOptions {
  name: string;
  namespace: string;
  url: string;
  description?: string;
  /** Default STREAMABLE_HTTP (kagent 0.9.x default). */
  protocol?: "SSE" | "STREAMABLE_HTTP";
  timeout?: string; // e.g. "30s"
  sseReadTimeout?: string; // e.g. "5m0s"
}

export function remoteMcp(
  scope: Construct,
  id: string,
  opts: RemoteMcpOptions,
): ApiObject {
  const spec: Record<string, unknown> = { url: opts.url };
  if (opts.description) spec.description = opts.description;
  spec.protocol = opts.protocol ?? "STREAMABLE_HTTP";
  if (opts.timeout) spec.timeout = opts.timeout;
  if (opts.sseReadTimeout) spec.sseReadTimeout = opts.sseReadTimeout;
  return new ApiObject(scope, id, {
    apiVersion: KAGENT_API,
    kind: "RemoteMCPServer",
    metadata: { name: opts.name, namespace: opts.namespace },
    spec,
  });
}

// ── MCPServer (v1alpha1 — a local MCP server kagent deploys & runs itself) ─────

export interface LocalMcpOptions {
  name: string;
  namespace: string;
  /** Container image (required by the MCPServer v1alpha1 CRD). */
  image: string;
  cmd: string;
  args?: string[];
  port?: number;
  transportType?: "stdio" | "http"; // default http
  env?: Record<string, string>;
}

/**
 * Author a kagent v1alpha1 `MCPServer` (deployment-backed). `transportType` is a sibling of
 * `deployment` and `deployment.image` is required (per the rendered CRD). // VERIFY the exact
 * spec.deployment shape (cmd/args/port/env) against the kagent docs before first use.
 */
export function localMcp(
  scope: Construct,
  id: string,
  opts: LocalMcpOptions,
): ApiObject {
  const deployment: Record<string, unknown> = { image: opts.image, cmd: opts.cmd };
  if (opts.args) deployment.args = opts.args;
  if (opts.port) deployment.port = opts.port;
  if (opts.env) deployment.env = opts.env;
  return new ApiObject(scope, id, {
    apiVersion: "kagent.dev/v1alpha1",
    kind: "MCPServer",
    metadata: { name: opts.name, namespace: opts.namespace },
    spec: { transportType: opts.transportType ?? "http", deployment },
  });
}
