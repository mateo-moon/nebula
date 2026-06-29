/**
 * Developer kubeconfig ConfigMap — the agent serves this directly when a developer asks
 * for access (no repo to clone, no manual file transfer). The agent reads it via
 * k8s-inspector (kubectl get configmap) and provides the YAML in the chat.
 *
 * Parameterized via env at synth time (per-cluster):
 *   CLUSTER_API_ENDPOINT  — the API server URL (e.g. the NLB)
 *   CLUSTER_CA            — base64 certificate-authority-data
 *   OIDC_CLIENT_ID        — Google OAuth client ID
 *   OIDC_CLIENT_SECRET    — Google OAuth client secret (Desktop/public client)
 *   CLUSTER_NAME          — display name for the kubeconfig context (default: the cluster)
 */
import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";

export interface DevKubeconfigOptions {
  endpoint: string;
  ca: string; // base64 certificate-authority-data
  clientId: string;
  clientSecret: string;
  clusterName?: string;
}

/** Create the developer-kubeconfig ConfigMap with a ready-to-use OIDC kubeconfig. */
export function declareDevKubeconfig(
  scope: Construct,
  ns: string,
  opts: DevKubeconfigOptions,
): void {
  const name = opts.clusterName ?? "kagent-cluster";
  const kubeconfig = [
    "apiVersion: v1",
    "kind: Config",
    "clusters:",
    `  - name: ${name}`,
    "    cluster:",
    `      server: ${opts.endpoint}`,
    `      certificate-authority-data: ${opts.ca}`,
    "users:",
    "  - name: oidc",
    "    user:",
    "      exec:",
    "        apiVersion: client.authentication.k8s.io/v1",
    "        command: kubectl",
    "        args:",
    "          - oidc-login",
    "          - get-token",
    "          - --oidc-issuer-url=https://accounts.google.com",
    `          - --oidc-client-id=${opts.clientId}`,
    `          - --oidc-client-secret=${opts.clientSecret}`,
    "          - --oidc-extra-scope=email",
    "          - --grant-type=authcode",
    "        interactiveMode: IfAvailable",
    "contexts:",
    `  - name: ${name}`,
    `    context: { cluster: ${name}, user: oidc }`,
    `current-context: ${name}`,
  ].join("\n");

  new ApiObject(scope, "dev-kubeconfig", {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "developer-kubeconfig", namespace: ns },
    data: { kubeconfig },
  });
}
