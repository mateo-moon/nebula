import { createHash } from "node:crypto";
import { CONFIDENTIAL_GROUP, renderConfidentialWorkload, validateStorage, validateWorkload,
  type ConfidentialStorageResource, type ConfidentialWorkloadResource } from "nebula-cdk8s/confidential-workloads";
import type { Kubernetes } from "./kubernetes";
import { KubernetesError } from "./kubernetes";

const ownerLabel = `${CONFIDENTIAL_GROUP}/owner`;
const renderLabel = `${CONFIDENTIAL_GROUP}/spec-sha256`;
const group = (ns: string) => `/apis/${CONFIDENTIAL_GROUP}/v1alpha1/namespaces/${encodeURIComponent(ns)}`;
const core = (ns: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Render = typeof renderConfidentialWorkload;

export class ConfidentialReconciler {
  #plans = new Map<string, ReturnType<Render>>();
  constructor(private readonly kube: Kubernetes, private readonly render: Render = renderConfidentialWorkload) {}

  async reconcileNamespace(namespace: string): Promise<void> {
    const workloads = await this.kube.call<{ items: ConfidentialWorkloadResource[] }>("GET", `${group(namespace)}/confidentialworkloads`);
    const storages = await this.kube.call<{ items: ConfidentialStorageResource[] }>("GET", `${group(namespace)}/confidentialstorages`);
    for (const storage of storages.items) {
      try {
        validateStorage(storage);
        if (storage.spec.type === "EncryptedBlock") {
          const pvc = await this.kube.call("GET", `${core(namespace)}/persistentvolumeclaims/${storage.spec.claimName}`);
          if (pvc.spec.volumeMode !== "Block") throw new Error("Encrypted storage requires a raw block PVC");
          await this.status("confidentialstorages", storage, {
            phase: pvc.status?.phase === "Bound" ? "Available" : "AwaitingBinding",
            message: "Ciphertext claim only; key custody and volume opening remain inside the guest",
          });
        } else await this.status("confidentialstorages", storage, { phase: "Available", message: "Guest memory storage" });
      } catch (error) {
        await this.status("confidentialstorages", storage, { phase: "Invalid", message: this.message(error) });
      }
    }
    for (const workload of workloads.items) {
      try { await this.workload(workload, storages.items); }
      catch (error) {
        await this.status("confidentialworkloads", workload, { phase: "Error", message: this.message(error) });
      }
    }
    // Bound cached plans to currently declared resources. No keys are cached.
    const live = new Set(workloads.items.map(workload => workload.metadata.uid));
    for (const key of this.#plans.keys()) if (!live.has(key.split(":")[0])) this.#plans.delete(key);
  }

  private async workload(workload: ConfidentialWorkloadResource, storages: ConfidentialStorageResource[]): Promise<void> {
    validateWorkload(workload, storages);
    const { namespace, name, uid } = workload.metadata;
    if (!uid) throw new Error("Kubernetes resource UID is missing");
    for (const binding of workload.spec.storage ?? []) {
      const storage = storages.find(s => s.metadata.name === binding.resource)!;
      if (storage.spec.type === "EncryptedBlock") {
        const pvc = await this.kube.call("GET", `${core(namespace)}/persistentvolumeclaims/${storage.spec.claimName}`);
        if (pvc.spec.volumeMode !== "Block" || pvc.metadata.deletionTimestamp) throw new Error("The block claim is unavailable");
      }
    }
    const relevant = storages.filter(storage => workload.spec.storage?.some(binding => binding.resource === storage.metadata.name));
    const key = `${uid}:${digest({ spec: workload.spec, storages: relevant.map(storage => storage.spec) })}`;
    let plan = this.#plans.get(key);
    if (!plan) {
      plan = this.render(workload, storages, { genpolicy: {
        executable: process.env.GENPOLICY ?? "/usr/local/bin/genpolicy",
        cacheDirectory: "/tmp/genpolicy-cache",
      } });
      for (const old of this.#plans.keys()) if (old.startsWith(`${uid}:`)) this.#plans.delete(old);
      this.#plans.set(key, plan);
    }
    const found = await this.kube.call<{ items: any[] }>("GET",
      `${core(namespace)}/pods?labelSelector=${encodeURIComponent(`${ownerLabel}=${uid}`)}`);
    const owned = found.items.filter(pod => pod.metadata.ownerReferences?.some((owner: any) =>
      owner.uid === uid && owner.kind === "ConfidentialWorkload" && owner.controller === true));
    if (found.items.length !== owned.length || owned.length > 1) throw new Error("Conflicting workload Pods; owner intervention required");
    let pod = owned[0];
    if (pod && pod.metadata.annotations?.[renderLabel] !== plan.specSha256) {
      await this.status("confidentialworkloads", workload, { phase: "UpdatePending",
        message: "Configuration changed. Explicitly retire the current Pod and enroll its replacement.",
        podName: pod.metadata.name, podUid: pod.metadata.uid });
      return;
    }
    const ownerReferences = [{ apiVersion: workload.apiVersion, kind: workload.kind, name, uid, controller: true, blockOwnerDeletion: false }];
    if (!pod) {
      pod = await this.kube.call("POST", `${core(namespace)}/pods`, { ...plan.pod,
        metadata: { ...plan.pod.metadata, ownerReferences, labels: { [ownerLabel]: uid },
          annotations: { ...plan.pod.metadata!.annotations, [renderLabel]: plan.specSha256 } } });
    }
    const service = { apiVersion: "v1", kind: "Service", metadata: { name, namespace, ownerReferences },
      spec: { selector: { [ownerLabel]: uid }, ports: [
        { name: "owner", port: 8443, targetPort: 8443 },
        ...workload.spec.containers.flatMap(container => (container.ports ?? []).map(port =>
          ({ name: port.name, port: port.port, targetPort: port.port }))),
      ] } };
    try {
      const existing = await this.kube.call("GET", `${core(namespace)}/services/${name}`);
      if (existing.spec.selector?.[ownerLabel] !== uid ||
          !existing.metadata.ownerReferences?.some((owner: any) => owner.uid === uid)) {
        throw new Error("Service belongs to another resource");
      }
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) await this.kube.call("POST", `${core(namespace)}/services`, service);
      else throw error;
    }
    const ready = pod.status?.conditions?.some((condition: any) => condition.type === "Ready" && condition.status === "True");
    await this.status("confidentialworkloads", workload, { phase: ready ? "Running" :
      ["Failed", "Succeeded"].includes(pod.status?.phase) ? "Stopped" : "AwaitingOwner",
    message: ready ? "Kubernetes reports ready; verify guest attestation with the owner CLI" :
      "Owner verification and enrollment are required before provisioning keys",
    podName: pod.metadata.name, podUid: pod.metadata.uid, specSha256: plan.specSha256,
    initDataSha256: plan.identity.initDataSha256 });
  }

  private message(error: unknown): string {
    // Native tool stderr can contain registry details; expose only a bounded
    // ordinary error, never the full renderer output or API response bodies.
    return (error instanceof Error ? error.message.split("\n")[0] : "Reconciliation failed").slice(0, 512);
  }
  private async status(plural: string, resource: ConfidentialWorkloadResource | ConfidentialStorageResource, value: object) {
    const status = { observedGeneration: resource.metadata.generation ?? 0, ...value };
    if (JSON.stringify((resource as any).status) === JSON.stringify(status)) return;
    await this.kube.call("PATCH", `${group(resource.metadata.namespace)}/${plural}/${resource.metadata.name}/status`,
      { metadata: { resourceVersion: resource.metadata.resourceVersion }, status });
  }
}
