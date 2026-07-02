/**
 * Verified kagent built-in tool names (the `kagent-tool-server` MCP server shipped by
 * the chart, kagent 0.9.7) plus the propose-then-approve gating lists.
 *
 * Convention: read tools are used freely; every mutation tool MUST appear in the
 * agent's `requireApproval` so it surfaces an input-required (Approve/Reject) prompt.
 */

export const K8S_READ_TOOLS = [
  "k8s_get_resources",
  "k8s_get_available_api_resources",
  "k8s_get_resource_yaml",
  "k8s_describe_resource",
  "k8s_get_pod_logs",
  "k8s_get_events",
  "k8s_get_cluster_configuration",
  "k8s_check_service_connectivity",
] as const;

export const HELM_READ_TOOLS = ["helm_list_releases", "helm_get_release"] as const;

export const PROM_TOOLS = ["prometheus_query_tool"] as const;

export const MISC_TOOLS = ["datetime_get_current_time"] as const;

/** Mutation tools — every one MUST be gated behind `requireApproval`. */
export const GATED_WRITE_TOOLS = [
  "k8s_apply_manifest",
  "k8s_delete_resource",
  "helm_upgrade",
  "helm_uninstall",
] as const;

/** Full read-only toolset an inspector / triager may use without approval. */
export const READ_ONLY_TOOLS: readonly string[] = [
  ...K8S_READ_TOOLS,
  ...HELM_READ_TOOLS,
  ...PROM_TOOLS,
  ...MISC_TOOLS,
];

// ── github-mcp-server tools (Phase 2). VERIFY exact names against the server's tool list. ──

/** Read-only GitHub tools (inspect issues/PRs/code) — ungated. */
export const GITHUB_READ_TOOLS = [
  "get_issue",
  "list_issues",
  "get_pull_request",
  "list_pull_requests",
  "get_file_contents",
  "search_repositories",
  "list_commits",
] as const;

/** Propose tools (create branch / draft PR / open issue) — ungated (PROPOSE is free). */
export const GITHUB_PROPOSE_TOOLS = [
  "create_issue",
  "update_issue",
  "add_issue_comment",
  "create_branch",
  "create_pull_request",
] as const;

/** Mutation tools that land/destroy commits — GATED behind requireApproval (an APPROVE, not PROPOSE).
 *  `create_or_update_file` pushes a direct commit; with ArgoCD reconciling, that can apply
 *  cluster-wide, so it must trip the gate. */
export const GITHUB_GATED_TOOLS = ["merge_pull_request", "delete_file", "create_or_update_file"] as const;
