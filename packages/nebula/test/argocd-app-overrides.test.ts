import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ArgoCdAppTier, type ArgoCdAppTierConfig } from "../src/modules/k8s/argocd";

const tier = (extra: Partial<ArgoCdAppTierConfig>) => {
  const chart = new Chart(new App(), "test");
  new ArgoCdAppTier(chart, "tier", {
    repoUrl: "https://git.example.test/platform.git", targetRevision: "main", namePrefix: "app-",
    discovery: { mode: "registry", modules: [{ mod: "one" }, { mod: "two" }] },
    ...extra,
  });
  return Object.fromEntries(Testing.synth(chart).filter(o => o.kind === "Application").map(o => [o.metadata.name, o]));
};

test("overrides change only the named Application and leave the rest as discovered", () => {
  const plain = tier({});
  const changed = tier({
    everyApplication: name => ({ generatePaths: [`/shared/${name}`] }),
    applications: { "app-one": {
      destination: { server: "https://kubernetes.default.svc", namespace: "default" }, project: "workloads",
      syncOptions: ["ApplyOutOfSyncOnly=true"], wave: -1, env: [{ name: "TARGET", value: "v1" }],
      retry: { refresh: true },
      ignoreDifferences: [{ group: "apps", kind: "Deployment", jsonPointers: ["/spec/replicas"] }],
      generatePaths: ["/extra"],
    } },
  });
  const one = changed["app-one"], before = plain["app-one"];
  assert.deepEqual(one.spec.destination, { server: "https://kubernetes.default.svc", namespace: "default" });
  assert.equal(one.spec.project, "workloads");
  assert.deepEqual(one.spec.syncPolicy.syncOptions, [...before.spec.syncPolicy.syncOptions, "ApplyOutOfSyncOnly=true"]);
  assert.deepEqual(one.spec.syncPolicy.retry, { ...before.spec.syncPolicy.retry, refresh: true });
  assert.equal(one.metadata.annotations["argocd.argoproj.io/sync-wave"], "-1");
  assert.deepEqual(one.spec.source.plugin.env.at(-1), { name: "TARGET", value: "v1" });
  assert.deepEqual(one.spec.ignoreDifferences.at(-1), { group: "apps", kind: "Deployment", jsonPointers: ["/spec/replicas"] });
  const paths = "argocd.argoproj.io/manifest-generate-paths";
  const base = (name: string) => plain[name].metadata.annotations?.[paths];
  assert.equal(one.metadata.annotations[paths], [base("app-one"), "/shared/app-one", "/extra"].filter(Boolean).join(";"));
  const two = structuredClone(changed["app-two"]);
  assert.equal(two.metadata.annotations[paths], [base("app-two"), "/shared/app-two"].filter(Boolean).join(";"));
  const untouched = structuredClone(plain["app-two"]);
  delete two.metadata.annotations; delete untouched.metadata.annotations;
  assert.deepEqual(two, untouched);
});

test("an Application can be renamed or given a namespace, and an unknown name is an error", () => {
  const changed = tier({ applications: { "app-one": { name: "renamed", namespace: "kube-system" } } });
  assert.deepEqual(Object.keys(changed).sort(), ["app-two", "renamed"]);
  assert.equal(changed.renamed.spec.destination.namespace, "kube-system");
  assert.throws(() => tier({ applications: { "app-three": { wave: 1 } } }), /app-three is not part of this tier/);
});
