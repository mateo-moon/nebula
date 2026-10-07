import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { configureArgocdPluginImageUpdate, type ArgocdPluginImageUpdateConfig } from "../src/modules/k8s/argocd-image-updater/plugin-policy";

const config: ArgocdPluginImageUpdateConfig = {
  application: "dev-worker", name: "dev-worker", image: {
    alias: "worker", repository: "registry.example.test/team/worker", trackingTag: "rolling-dev", pluginSpec: "WORKER_IMAGE",
  },
};
test("digest updates keep one exact Application, plugin variable and least-privilege write grant", () => {
  const chart = Testing.chart();
  configureArgocdPluginImageUpdate(chart, "updater", config);
  const resources = Testing.synth(chart);
  assert.equal(resources.length, 3);
  assert.deepEqual(resources.find(resource => resource.kind === "Role")!.rules,
    [{ apiGroups: ["argoproj.io"], resources: ["applications"], resourceNames: ["dev-worker"], verbs: ["patch", "update"] }]);
  assert.deepEqual(resources.find(resource => resource.kind === "RoleBinding")!.subjects,
    [{ kind: "ServiceAccount", name: "argocd-image-updater", namespace: "argocd" }]);
  const updater = resources.find(resource => resource.kind === "ImageUpdater")!;
  assert.equal(updater.metadata.annotations["argocd.argoproj.io/sync-wave"], "7");
  assert.deepEqual(updater.spec, {
    writeBackConfig: { method: "argocd" }, applicationRefs: [{ namePattern: "dev-worker", images: [{
      alias: "worker", imageName: "registry.example.test/team/worker:rolling-dev",
      commonUpdateSettings: { updateStrategy: "digest", platforms: ["linux/amd64"] },
      manifestTargets: { plugin: { spec: "WORKER_IMAGE" } },
    }] }],
  });
});
test("policy refuses a wildcard Application and invalid plugin/tag configuration", () => {
  for (const value of [
    { ...config, application: "dev-*" }, { ...config, image: { ...config.image, trackingTag: "tag@sha256:digest" } },
    { ...config, image: { ...config.image, pluginSpec: "IMAGE\nOTHER" } },
    { ...config, image: { ...config.image, platforms: [] } },
  ]) assert.throws(() => configureArgocdPluginImageUpdate(Testing.chart(), "updater", value));
});
