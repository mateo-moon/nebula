import assert from "node:assert/strict";
import { test } from "node:test";
import { KUBERNETES_API_SERVICE_ENV, withNeutralKubernetesServiceEnv } from "../src/modules/k8s/trustee/runtime-env";
import { trusteeSettings } from "../src/modules/k8s/trustee/settings";
import { trusteeConfig } from "./support/trustee";

test("measured service defaults suppress implicit API discovery without overwriting owner literals", () => {
  const original = [{ name: "KUBERNETES_SERVICE_HOST", value: "owner-approved" }, { name: "HOME", value: "/tmp" }];
  const result = withNeutralKubernetesServiceEnv(original);
  assert.equal(result.length, 9);
  for (const name of KUBERNETES_API_SERVICE_ENV) assert.deepEqual(result.filter(value => value.name === name),
    [{ name, value: name === "KUBERNETES_SERVICE_HOST" ? "owner-approved" : "" }]);
  assert.deepEqual(original, [{ name: "KUBERNETES_SERVICE_HOST", value: "owner-approved" }, { name: "HOME", value: "/tmp" }]);
  assert.deepEqual(withNeutralKubernetesServiceEnv(result), result, "applying the defaults twice cannot add duplicates");
});

test("the official Trustee chart and its TNG extension receive the same explicit measured defaults", () => {
  const settings = trusteeSettings(trusteeConfig());
  for (const env of [settings.values.kbs.extraEnvVars, ...settings.extensions.extraContainers.map(container => container.env!)]) {
    for (const name of KUBERNETES_API_SERVICE_ENV) assert.deepEqual(env.filter(value => value.name === name), [{ name, value: "" }]);
  }
});
