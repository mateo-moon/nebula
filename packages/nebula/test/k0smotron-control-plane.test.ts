import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { K0smotronControlPlane } from "../src/modules/infra/k0s/k0smotron-control-plane";
import { K0smotronCluster, type K0smotronClusterConfig } from "../src/modules/infra/k0s/k0smotron-cluster";
import type { K0sInfraProvider } from "../src/modules/infra/k0s/cluster";

const provider: K0sInfraProvider<never> = {
  infraClusterApiGroup: "infrastructure.cluster.x-k8s.io",
  infraClusterKind: "AWSCluster",
  emitInfraCluster: () => {},
  emitMachineTemplate: () => { throw new Error("no worker pools in these tests"); },
};

function k0sSpecOf(controlPlane: K0smotronClusterConfig<never>["controlPlane"]) {
  const chart = Testing.chart();
  new K0smotronCluster(chart, "cicd", { name: "cicd", networkProvider: "custom", controlPlane, provider });
  const cp = Testing.synth(chart).filter(r => r.kind === "K0smotronControlPlane");
  assert.equal(cp.length, 1);
  return cp[0].spec.k0sConfig;
}

test("controller-manager extra args land in the k0s spec next to the apiserver's", () => {
  const k0sConfig = k0sSpecOf({
    apiExtraArgs: { "oidc-issuer-url": "https://dex.example.test" },
    controllerManagerExtraArgs: { "terminated-pod-gc-threshold": "100" },
  });
  assert.deepEqual(k0sConfig.spec.controllerManager, { extraArgs: { "terminated-pod-gc-threshold": "100" } });
  assert.deepEqual(k0sConfig.spec.api, { extraArgs: { "oidc-issuer-url": "https://dex.example.test" } });
  assert.equal(k0sConfig.controllerManager, undefined);
});

test("without controller-manager extra args the k0s config has no controllerManager block", () => {
  for (const controlPlane of [undefined, { apiExtraArgs: { "oidc-issuer-url": "https://dex.example.test" } }]) {
    assert.ok(!("controllerManager" in k0sSpecOf(controlPlane).spec));
  }
  const chart = Testing.chart();
  new K0smotronControlPlane(chart, "cp", { name: "cp" });
  const [cp] = Testing.synth(chart);
  assert.ok(!("controllerManager" in cp.spec.k0sConfig.spec));
});

test("ordered raw API arguments preserve repeated issuers beside the primary issuer", () => {
  const extraArgs = {
    "service-account-issuer": "https://issuer.example.test",
    "service-account-jwks-uri": "https://issuer.example.test/keys.json",
  };
  const rawArgs = [
    "--service-account-issuer=https://kubernetes.default.svc",
    "--service-account-issuer=https://previous.example.test",
  ];
  const config = k0sSpecOf({ apiExtraArgs: extraArgs, apiRawArgs: rawArgs });
  assert.deepEqual(config.spec.api, { extraArgs, rawArgs });
  assert.equal(config.api, undefined, "API configuration must be inside the k0s spec");
  assert.equal(config.spec.api.extraArgs["api-audiences"], undefined, "preserve k0s audiences");
});

test("raw arguments work without a map and leave omitted or empty configurations unchanged", () => {
  const rawArgs = ["--service-account-issuer=https://issuer.example.test"];
  assert.deepEqual(k0sSpecOf({ apiRawArgs: rawArgs }).spec.api, { rawArgs });
  assert.deepEqual(k0sSpecOf({ apiRawArgs: [] }), k0sSpecOf(undefined));
  const chart = Testing.chart();
  new K0smotronControlPlane(chart, "cp", { name: "cp", apiRawArgs: rawArgs });
  const [cp] = Testing.synth(chart);
  assert.deepEqual(cp.spec.k0sConfig.spec.api, { rawArgs });
});
