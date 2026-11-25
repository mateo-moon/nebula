import type { ConfidentialConnection } from "./connection";

export interface StorageSummary {
  /** The workload binding name, also used by the attested storage API. */
  name: string;
  resourceName: string;
  namespace: string;
  type: "EncryptedBlock" | "Memory";
  typeLabel: "Encrypted disk" | "Temporary memory";
  capacityBytes: number;
  capacityLabel: string;
  mounts: { container: string; path: string }[];
  persistence: string;
  initialization: string;
  keyRequirement: string;
}

/** Caller-supplied observations must retain their provenance. A configured
 * mount or a process-running report alone does not establish application use. */
export interface StorageOverviewStatus {
  label: string;
  detail: string;
  tone: "neutral" | "pending" | "success" | "danger";
}

function capacity(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Storage capacity must be a positive safe integer");
  const exact = bytes.toLocaleString("en-US");
  for (const [unit, size] of [["PiB", 2 ** 50], ["TiB", 2 ** 40], ["GiB", 2 ** 30], ["MiB", 2 ** 20], ["KiB", 2 ** 10]] as const) {
    if (bytes >= size && bytes % size === 0) return `${(bytes / size).toLocaleString("en-US")} ${unit} (${exact} bytes)`;
  }
  return `${exact} bytes`;
}

function memoryBytes(quantity: string): number {
  const parsed = /^([1-9][0-9]*)(Mi|Gi)$/.exec(quantity);
  if (!parsed) throw new Error("Temporary memory capacity must use Mi or Gi");
  const value = Number(parsed[1]) * (parsed[2] === "Mi" ? 2 ** 20 : 2 ** 30);
  capacity(value);
  return value;
}

/** Describe the declared storage contract, not live mount or application
 * activity. Binding aliases are primary; unrelated namespaces are never used. */
export function summarizeStorage(connection: Pick<ConfidentialConnection, "workload" | "storages">): StorageSummary[] {
  const { workload, storages } = connection, aliases = new Set<string>();
  return (workload.spec.storage ?? []).map(binding => {
    if (aliases.has(binding.name)) throw new Error("Storage binding names must be unique");
    aliases.add(binding.name);
    const matches = storages.filter(storage => storage.metadata.name === binding.resource &&
      storage.metadata.namespace === workload.metadata.namespace);
    if (matches.length !== 1) throw new Error("A storage binding must resolve to one resource in the workload namespace");
    const storage = matches[0], spec = storage.spec, memory = spec.type === "Memory";
    const capacityBytes = memory ? memoryBytes(spec.sizeLimit) : spec.sizeBytes;
    const mounts = workload.spec.containers.flatMap(container => (container.mounts ?? [])
      .filter(mount => mount.storage === binding.name).map(mount => ({ container: container.name, path: mount.path })));
    return {
      name: binding.name, resourceName: storage.metadata.name, namespace: storage.metadata.namespace,
      type: spec.type, typeLabel: memory ? "Temporary memory" : "Encrypted disk",
      capacityBytes, capacityLabel: capacity(capacityBytes), mounts,
      persistence: memory ? "Temporary: lost with the confidential VM. A supervised child-process restart keeps this memory." :
        "Retained encrypted disk. Keep both the disk and its encryption key for recovery.",
      initialization: memory ? "Created as temporary guest memory; no disk initialization." : spec.initialization === "Never" ?
        "Do not initialize or format this disk." : "Initialize an empty disk only.",
      keyRequirement: memory ? "No separate disk encryption key." : spec.initialization === "Never" ?
        "Provide the existing disk encryption key." : "A new disk gets a generated key; recovery needs its original key.",
    };
  });
}

/** Render trusted labels and arbitrary metadata through text nodes only. With
 * no observation, every card describes configuration and remains neutral. */
export function renderStorageOverview(parent: HTMLElement, summaries: readonly StorageSummary[],
  statuses: Readonly<Record<string, StorageOverviewStatus>> = {}): void {
  const dom = parent.ownerDocument;
  parent.classList.add("storage-overview");
  parent.replaceChildren();
  if (!summaries.length) {
    const empty = dom.createElement("p"); empty.className = "storage-empty";
    empty.textContent = "No storage is declared for this workload."; parent.append(empty); return;
  }
  for (const summary of summaries) {
    const card = dom.createElement("article"); card.className = "storage-card";
    const heading = dom.createElement("div"); heading.className = "storage-card-heading";
    const name = dom.createElement("h3"); name.className = "storage-card-name"; name.textContent = summary.name;
    const kind = dom.createElement("span"); kind.className = "storage-kind"; kind.textContent = summary.typeLabel;
    heading.append(name, kind);
    const supplied = Object.hasOwn(statuses, summary.name) ? statuses[summary.name] : undefined;
    const status: StorageOverviewStatus = supplied ?? (summary.type === "Memory" ? {
      label: "Temporary storage", detail: "Configured capacity and mounts only; the live memory mount and application use have not been checked.", tone: "neutral",
    } : { label: "Not checked yet", detail: "The encrypted disk has not been checked through the attested workload.", tone: "neutral" });
    const badge = dom.createElement("span"), tone = ["neutral", "pending", "success", "danger"].includes(status.tone) ? status.tone : "neutral";
    badge.className = `storage-status ${tone}`; badge.textContent = status.label;
    const detail = dom.createElement("p"); detail.className = "storage-status-detail"; detail.textContent = status.detail;
    const fields = dom.createElement("dl"); fields.className = "storage-details";
    const row = (parent: HTMLElement, label: string, value: string, title?: string) => {
      const group = dom.createElement("div"), key = dom.createElement("dt"), data = dom.createElement("dd");
      key.textContent = label; data.textContent = value;
      if (title) data.title = title;
      group.append(key, data); parent.append(group);
      return data;
    };
    const amount = row(fields, summary.type === "Memory" ? "Memory limit" : "Allocated disk size",
      summary.capacityLabel.replace(/ \([0-9,]+ bytes\)$/, ""), summary.capacityLabel);
    if (summary.type === "EncryptedBlock") {
      const hint = dom.createElement("small"); hint.className = "storage-capacity-hint";
      hint.textContent = "Usable filesystem space is smaller after encryption and formatting."; amount.append(hint);
    }
    for (const [label, value] of [
      ["Configured mounts", summary.mounts.length ? summary.mounts.map(mount => `${mount.container}: ${mount.path}`).join("; ") : "No application mounts declared"],
      ["Persistence", summary.persistence], ["Encryption key", summary.keyRequirement],
    ]) row(fields, label, value);
    const technical = dom.createElement("details"); technical.className = "storage-technical";
    const caption = dom.createElement("summary"); caption.textContent = "Technical storage details";
    const technicalFields = dom.createElement("dl"); technicalFields.className = "storage-details";
    row(technicalFields, "Storage resource", `${summary.namespace}/${summary.resourceName}`);
    row(technicalFields, "Initialization", summary.initialization);
    row(technicalFields, "Exact capacity", summary.capacityLabel);
    technical.append(caption, technicalFields);
    card.append(heading, badge, detail, fields, technical); parent.append(card);
  }
}
