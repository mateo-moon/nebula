/**
 * The DevOps agent topology — a portable kagent module for any Nebula cluster.
 *
 *   devops-orchestrator (sonnet, memory) — front door; routes, enforces approval.
 *          ├── docs-agent     (haiku) — cluster docs; "how to" / access / runbooks.
 *          ├── k8s-inspector  (haiku) — read-only cluster inspection.
 *          └── change-author  (sonnet) — drafts changes; every mutation gated.
 *
 * All systemMessages are GENERIC (no cluster-specific paths/names/endpoints).
 * The per-cluster context (access method, API endpoint, deploy commands) is injected
 * via the `clusterContext` parameter → a ConfigMap the docs-agent reads.
 * This makes the module reusable across any Nebula cluster.
 */
import type { Chart } from "cdk8s";
import { ApiObject } from "cdk8s";
import { agentTool, defineAgent, mcpTool } from "./crd";
import { ORCHESTRATOR_MODEL_CONFIG, SUBAGENT_MODEL_CONFIG } from "./models";
import {
  GATED_WRITE_TOOLS,
  GITHUB_GATED_TOOLS,
  GITHUB_PROPOSE_TOOLS,
  GITHUB_READ_TOOLS,
  READ_ONLY_TOOLS,
} from "./tools";

const TOOL_SERVER = "kagent-tool-server";

/**
 * kagent 0.9.7 controller bug workaround: the Go controller returns tasks without
 * the A2A `kind: "task"` field (not stored in the DB). The Python SDK's Task model
 * validates kind must be "task" → ValidationError → UI sessions hang. This sitecustomize.py
 * monkey-patches Task.model_validate to fix kind="" → "task" before validation.
 * Mounted via the Agent CR's deployment.volumes (kagent-managed, persists across restarts).
 */
const SITECUSTOMIZE_PY = [
  'try:',
  '    from a2a.types import Task',
  '    _orig = Task.model_validate',
  '    @classmethod',
  '    def _patched(cls, data, *a, **kw):',
  '        if isinstance(data, dict) and data.get("kind") == "":',
  '            data = dict(data, kind="task")',
  '        return _orig.__func__(cls, data, *a, **kw)',
  '    Task.model_validate = _patched',
  'except Exception:',
  '    pass',
].join("\n");

const KIND_FIX_DEPLOYMENT = {
  volumes: [{ name: "kind-fix", configMap: { name: "kagent-kind-fix" } }],
  volumeMounts: [{
    name: "kind-fix",
    // Mount the patched _task_store.py at the actual SDK path (replaces the original).
    // The ConfigMap `kagent-kind-fix` (key: _task_store.py) is managed via kubectl,
    // NOT by cdk8s — so the patched content persists across re-synths.
    mountPath: "/.kagent/packages/kagent-core/src/kagent/core/a2a/_task_store.py",
    subPath: "_task_store.py",
  }],
};

export interface DeclareAgentsOptions {
  githubMcp?: string;
  /** Name of the cluster-info RemoteMCPServer (from declareClusterInfoMcp). When set, the
   *  docs-agent gets get_cluster_info + get_access_instructions tools so its answers come
   *  from the live cluster-info server rather than only the frozen CLUSTER CONTEXT prompt. */
  clusterInfoMcp?: string;
  /** Per-cluster context (access method, API endpoint, deploy commands) for the docs-agent.
   *  Provide via env at synth time. If unset, the docs-agent tells users to ask the operator. */
  clusterContext?: string;
  /**
   * ModelConfig name for embedding generation (memory vector store).
   * CRITICAL: must be an OpenAI-compatible embedding model (e.g. text-embedding-3-small,
   * or Ollama nomic-embed-text). Anthropic does NOT have an embeddings API — using a
   * Claude model here silently fails (memories never get written). If unset, memory is disabled.
   */
  embeddingModelConfig?: string;
}

/** Declare the agents + the docs-agent context ConfigMap. */
export function declareAgents(
  chart: Chart,
  namespace: string,
  opts: DeclareAgentsOptions = {},
): void {
  const ctx = opts.clusterContext?.trim() || "(No cluster-specific context configured. Tell the user to ask the cluster operator for access details.)";

  // ── ConfigMap: per-cluster context for the docs-agent (updatable without re-deploy) ──
  const docsPrompt = [
    "You are docs-agent, the cluster documentation specialist.",
    "",
    "YOUR JOB: answer 'how to' / access / runbook / setup questions with SPECIFIC,",
    "copy-pasteable commands. Never give generic Kubernetes advice — always use the",
    "CLUSTER CONTEXT below for specifics (paths, endpoints, tools).",
    "",
    "If you don't have documented info, say so + suggest asking the operator.",
    "",
    "CLUSTER CONTEXT:",
    ctx,
  ].join("\n");

  // ── ConfigMaps ──────────────────────────────────────────────────────────────
  new ApiObject(chart, "docs-agent-context", {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "docs-agent-context", namespace },
    data: { prompt: docsPrompt },
  });
  // NOTE: the `kagent-kind-fix` ConfigMap (patched _task_store.py for the kind="" bug)
  // is managed via kubectl, NOT cdk8s — see KIND_FIX_DEPLOYMENT above + the deploy script.

  // ── docs-agent: cluster documentation (inline systemMessage; ConfigMap is a reference) ──
  // NOTE: kagent 0.9.7's CRD doesn't have systemMessageFrom — using inline systemMessage.
  // The ConfigMap (docs-agent-context) is kept as the updatable source; update both when
  // changing the cluster context. Future kagent versions may support systemMessageFrom.
  //
  // When clusterInfoMcp is wired, the docs-agent calls the live cluster-info MCP server
  // (get_cluster_info / get_access_instructions) for always-accurate specifics, instead of
  // relying solely on the frozen CLUSTER CONTEXT prompt.
  defineAgent(chart, "docs-agent", {
    name: "docs-agent",
    namespace,
    modelConfig: SUBAGENT_MODEL_CONFIG,
    deployment: KIND_FIX_DEPLOYMENT,
    description:
      "Cluster documentation specialist. Answers 'how to' / access questions with " +
      "specific commands for THIS cluster. Never gives generic advice.",
    systemMessage: docsPrompt,
    ...(opts.clusterInfoMcp
      ? {
          tools: [
            mcpTool(opts.clusterInfoMcp, {
              toolNames: ["get_cluster_info", "get_access_instructions"],
            }),
          ],
        }
      : {}),
  });

  // ── k8s-inspector: read-only cluster specialist ──────────────────────────────
  defineAgent(chart, "k8s-inspector", {
    name: "k8s-inspector",
    namespace,
    modelConfig: SUBAGENT_MODEL_CONFIG,
    deployment: KIND_FIX_DEPLOYMENT,
    description:
      "Read-only Kubernetes specialist. Inspects pods, events, logs, resources, " +
      "Helm releases, and Prometheus metrics. Returns concise, cited findings.",
    systemMessage: [
      "You are k8s-inspector, a read-only Kubernetes specialist.",
      "Inspect the cluster with your tools BEFORE answering. Cite exact resources.",
      "Return concise, structured findings. Do not propose fixes — that's change-author's job.",
      "You are STRICTLY READ-ONLY: never apply, delete, scale, restart, or mutate.",
    ].join(" "),
    tools: [mcpTool(TOOL_SERVER, { toolNames: [...READ_ONLY_TOOLS] })],
  });

  // ── change-author: drafts changes; mutations gated ───────────────────────────
  defineAgent(chart, "change-author", {
    name: "change-author",
    namespace,
    modelConfig: ORCHESTRATOR_MODEL_CONFIG,
    deployment: KIND_FIX_DEPLOYMENT,
    description:
      "Drafts infrastructure and code changes. Proposes manifests/branches/PRs; " +
      "applies only after approval. Never applies without explicit approval.",
    systemMessage: [
      "You are change-author, the change-drafting sub-agent.",
      "WORKFLOW: (1) understand the change; (2) inspect current state; (3) DRAFT the change",
      "(manifest patch, branch+PR, helm values) and present it for approval; (4) only after",
      "explicit human approval, apply/merge/upgrade.",
      "Every mutation tool is gated (requireApproval) — that pause IS the gate; don't bypass it.",
      "Drafting is free; applying/merging/deleting is gated. Prefer the smallest reversible change.",
    ].join(" "),
    tools: [
      mcpTool(TOOL_SERVER, {
        toolNames: [...READ_ONLY_TOOLS, ...GATED_WRITE_TOOLS],
        requireApproval: [...GATED_WRITE_TOOLS],
      }),
      ...(opts.githubMcp
        ? [mcpTool(opts.githubMcp, {
            toolNames: [...GITHUB_READ_TOOLS, ...GITHUB_PROPOSE_TOOLS, ...GITHUB_GATED_TOOLS],
            requireApproval: [...GITHUB_GATED_TOOLS],
          })]
        : []),
    ],
  });

  // ── devops-orchestrator: front door — routes, enforces approval, remembers ────
  defineAgent(chart, "devops-orchestrator", {
    name: "devops-orchestrator",
    namespace,
    modelConfig: ORCHESTRATOR_MODEL_CONFIG,
    deployment: KIND_FIX_DEPLOYMENT,
    description:
      "The DevOps engineer agent. Understands intent, routes to specialists, " +
      "enforces propose-then-approve, reports clearly.",
    systemMessage: [
      "You are devops-orchestrator, an autonomous DevOps engineer agent.",
      "",
      "ROUTING (decide FIRST):",
      "- 'How to' / access / docs / setup → ANSWER DIRECTLY using the CLUSTER CONTEXT below.",
      "  Do NOT use ask_user. Do NOT gate these. Return the answer immediately.",
      "- Info / report / status ('which model', 'what does X cost', 'summarize',",
      "  'list deployments', 'top risks', 'list releases') → ANSWER DIRECTLY or delegate to",
      "  `k8s-inspector`. These are READS — NEVER gate, NEVER ask_user, NEVER input-required.",
      "- 'What is' / inspect / diagnose → delegate to `k8s-inspector` (read-only).",
      "- 'Change' / 'apply' / 'fix' / 'create' / 'deploy' / 'scale' / 'restart' / 'delete'",
      "  → ALWAYS delegate to `change-author`. Never handle mutations inline.",
      "",
      "CRITICAL: Never call ask_user for access/how-to/info questions. Answer directly.",
      "If unsure whether something is a read or a mutation, it's a read — answer it.",
      "",
      "NEVER give generic advice. Always use the CLUSTER CONTEXT for specifics.",
      "If a cluster-wide query is too large, scope it per-namespace or fall back to kubectl commands.",
      "",
      "PROPOSE-THEN-APPROVE: inspect freely; any change proposed first, applied only after approval.",
      "Never fabricate state — rely on sub-agent results. Be concise.",
      "",
      "CLUSTER CONTEXT:",
      ctx,
      "",
      "ACCESS ANSWER (use this verbatim when asked about access — do NOT ask_user):",
      "Developers: 1) kubectl krew install oidc-login  2) get kubeconfig-dev.yaml  3) KUBECONFIG=kubeconfig-dev.yaml kubectl get nodes → Google SSO.",
      "Operators: export KUBECONFIG=~/.nebula/<cluster>/kubeconfig; kubectl get nodes.",
      "Provide BOTH methods in your answer. Never ask which role they are.",
    ].join("\n"),
    // Vector memory (cross-session recall; pgvector verified).
    // CRITICAL: the modelConfig must point to an EMBEDDING model (OpenAI-compatible),
    // NOT a chat model. Anthropic has no embeddings API — using claude-* here silently
    // fails (memories never written). See DeclareAgentsOptions.embeddingModelConfig.
    ...(opts.embeddingModelConfig
      ? { memory: { modelConfig: opts.embeddingModelConfig, ttlDays: 30 } }
      : {}),
    tools: [
      agentTool("docs-agent", namespace),
      agentTool("k8s-inspector", namespace),
      agentTool("change-author", namespace),
    ],
  });
}
