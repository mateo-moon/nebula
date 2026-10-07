import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Testing } from "cdk8s";
import { ArgoCdAppTier } from "../src/modules/k8s/argocd/app-tier";
import { confidentialProject } from "../src/modules/k8s/argocd/confidential-project";

test("splitting cluster services across roots changes only their source path", () => {
  const root = mkdtempSync(join(tmpdir(), "app-discovery-"));
  try {
    for (const path of ["before/cluster", "before/network", "before/app", "after/cluster", "after/network", "workloads/app"])
      mkdirSync(join(root, path), { recursive: true });
    const render = (dir: string, serviceDirectories?: { dir: string; pathDir: string }[]) => {
      const chart = Testing.chart();
      new ArgoCdAppTier(chart, "tier", {
        repoUrl: "https://example.test/repo.git", targetRevision: "main", pathPrefix: "infra",
        project: "platform", sharedGeneratePaths: ["infra/config.ts"],
        discovery: { mode: "cluster", clusterName: "dev", dir: join(root, dir), pathDir: "clusters/dev",
          clusterApp: {}, serviceDirectories, extraGeneratePaths: { app: ["/applications/app"] },
          extraIgnoreDifferences: { app: [{ group: "", kind: "Secret", jsonPointers: ["/data"] }] },
        },
      });
      return Testing.synth(chart).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    };
    const original = render("before");
    assert.deepEqual(render("before", []), original, "the opt-in must preserve defaults");
    const split = render("after", [{ dir: join(root, "workloads"), pathDir: "workloads/dev" }]);
    const workload = split.find(r => r.metadata.name === "dev-app")!;
    assert.equal(workload.spec.source.path, "infra/workloads/dev/app");
    workload.spec.source.path = "infra/clusters/dev/app";
    assert.deepEqual(split, original);
    mkdirSync(join(root, "workloads/network"));
    assert.throws(() => render("after", [{ dir: join(root, "workloads"), pathDir: "workloads/dev" }]), /duplicate service module network/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confidential projects require exact dedicated access and only grant get/sync", () => {
  const config = { name: "app", namespace: "app", repoUrl: "https://example.test/repo.git",
    clusterName: "dev", allowedUsers: ["operator@example.test"], protectedProjectNames: ["platform"] };
  const chart = Testing.chart();
  confidentialProject(chart, "project", config);
  const project = Testing.synth(chart)[0];
  assert.deepEqual(project.spec.destinations, [{ name: "dev", namespace: "app" }]);
  assert.deepEqual(project.spec.roles[0].policies, [
    "p, proj:app:operator, applications, get, app/*, allow",
    "p, proj:app:operator, applications, sync, app/*, allow",
  ]);
  for (const override of [{ name: "platform" }, { name: "default" }, { namespace: "default" },
    { allowedUsers: ["*"] }, { repoUrl: "*" }, { clusterName: "*" }])
    assert.throws(() => confidentialProject(Testing.chart(), "invalid", { ...config, ...override }), /exact source/);
});
