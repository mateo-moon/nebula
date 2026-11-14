/** Kubelet injects these API-service variables even with enableServiceLinks
 * disabled. Explicit empty defaults keep them measured instead of letting the
 * host choose an implicit API endpoint. Owner-provided literals take precedence. */
export const KUBERNETES_API_SERVICE_ENV = [
  "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "KUBERNETES_SERVICE_PORT_HTTPS",
  "KUBERNETES_PORT", "KUBERNETES_PORT_443_TCP", "KUBERNETES_PORT_443_TCP_PROTO",
  "KUBERNETES_PORT_443_TCP_PORT", "KUBERNETES_PORT_443_TCP_ADDR",
] as const;

export function withNeutralKubernetesServiceEnv<T extends { name: string }>(env: readonly T[] = []) {
  const explicit = new Set(env.map(variable => variable.name));
  return [...KUBERNETES_API_SERVICE_ENV.filter(name => !explicit.has(name)).map(name => ({ name, value: "" })), ...env];
}
