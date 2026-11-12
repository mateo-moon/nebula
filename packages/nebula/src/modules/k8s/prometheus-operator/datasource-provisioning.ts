import { ApiObject, JsonPatch } from "cdk8s";
import { createHash } from "node:crypto";

export interface GrafanaDatasourceProvisioningOptions {
  /** Use Recreate when Grafana's persistent database permits only one writer. */
  singleWriter?: boolean;
}

interface Environment { name: string; value?: string; valueFrom?: unknown }
interface Sidecar { name: string; env?: Environment[] }

/** Provision all datasource files at startup and roll only when their content changes. */
export function provisionGrafanaDatasources(
  deployment: ApiObject, datasources: readonly ApiObject[], options: GrafanaDatasourceProvisioningOptions = {},
): void {
  if (deployment.kind !== "Deployment" || !datasources.length) throw new Error("Grafana provisioning requires a Deployment and datasource ConfigMaps");
  const names = new Set<string>();
  const configurations = datasources.map(source => {
    const value = source.toJson();
    if (source.kind !== "ConfigMap" || value.metadata.namespace !== deployment.toJson().metadata.namespace || names.has(source.name))
      throw new Error("Datasource ConfigMaps must have distinct names in Grafana's namespace");
    names.add(source.name);
    return { name: value.metadata.name, data: Object.fromEntries(Object.entries(value.data).sort(([a], [b]) => a.localeCompare(b))) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const init: Sidecar[] | undefined = deployment.toJson().spec.template.spec.initContainers;
  const index = init?.findIndex(container => container.name.includes("datasources")) ?? -1;
  if (index < 0 || !init?.[index]?.env?.some(entry => entry.name === "METHOD"))
    throw new Error("Missing datasource provisioning init container and sidecar mode");
  const environment = init[index]!.env!.filter(entry => !["REQ_URL", "REQ_METHOD", "REQ_USERNAME", "REQ_PASSWORD", "UNIQUE_FILENAMES"].includes(entry.name))
    .map(entry => entry.name === "METHOD" ? { name: "METHOD", value: "LIST" } : entry);
  environment.push({ name: "UNIQUE_FILENAMES", value: "true" });
  deployment.addJsonPatch(
    ...(options.singleWriter ? [JsonPatch.replace("/spec/strategy", { type: "Recreate" })] : []),
    JsonPatch.replace(`/spec/template/spec/initContainers/${index}/env`, environment),
    JsonPatch.add("/spec/template/metadata/annotations/checksum~1datasource-configuration", createHash("sha256").update(JSON.stringify(configurations)).digest("hex")),
  );
}
