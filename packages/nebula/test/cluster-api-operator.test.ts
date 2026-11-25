import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { ClusterApiOperator } from "../src/modules/k8s/cluster-api-operator";
import { withStubHelm } from "./helm-stub";

test("k0smotron component URLs follow the effective release for each provider", () => {
  withStubHelm(valuesOf => {
    new ClusterApiOperator(Testing.chart(), "capi", {
      infrastructure: { k0smotron: { version: "v2.0.4" } },
      controlPlane: { k0smotron: { version: "v2.2.0" } },
      values: { controlPlane: { k0smotron: { version: "v2.3.0" } } },
    });
    const values = valuesOf("capi-operator");
    const releases = "https://github.com/k0sproject/k0smotron/releases/download";
    for (const [tier, component, tag] of [
      ["infrastructure", "infrastructure", "v2.0.4"],
      ["controlPlane", "control-plane", "v2.3.0"],
      ["bootstrap", "bootstrap", "v2.3.1"],
    ]) {
      const provider = values[tier].k0smotron;
      assert.equal(provider.version, tag);
      assert.equal(provider.fetchConfig.url, `${releases}/${tag}/${component}-components.yaml`);
    }
  });
});

test("an explicit component URL can point to a private release mirror", () => {
  withStubHelm(valuesOf => {
    const url = "https://mirror.example.test/bootstrap-components.yaml";
    new ClusterApiOperator(Testing.chart(), "capi", {
      bootstrap: { k0smotron: { version: "v2.0.4" } },
      values: { bootstrap: { k0smotron: { fetchConfig: { url } } } },
    });
    assert.equal(valuesOf("capi-operator").bootstrap.k0smotron.fetchConfig.url, url);
  });
});
