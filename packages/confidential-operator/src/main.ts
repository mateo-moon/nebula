import { setTimeout as delay } from "node:timers/promises";
import { InClusterKubernetes } from "./kubernetes";
import { ConfidentialReconciler } from "./reconcile";

const namespaces = (process.env.WATCH_NAMESPACES ?? "").split(",");
if (!namespaces.length || namespaces.some(value => !/^[a-z][a-z0-9-]{0,39}$/.test(value))) {
  throw new Error("WATCH_NAMESPACES must explicitly name the managed namespaces");
}
const stopped = new AbortController();
process.on("SIGTERM", () => stopped.abort());
process.on("SIGINT", () => stopped.abort());
const reconciler = new ConfidentialReconciler(new InClusterKubernetes());
while (!stopped.signal.aborted) {
  for (const namespace of namespaces) {
    if (stopped.signal.aborted) break;
    try { await reconciler.reconcileNamespace(namespace); }
    catch { console.error(`Reconciliation failed for namespace ${namespace}; will retry`); }
  }
  try { await delay(10_000, undefined, { signal: stopped.signal }); } catch {}
}
