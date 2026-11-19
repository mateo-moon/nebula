import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { Descheduler } from "../src/modules/k8s/descheduler";
import { withStubHelm } from "./helm-stub";

test("descheduler uses the configured plugins in their extension point order", () => {
  withStubHelm(valuesOf => {
    new Descheduler(Testing.chart(), "descheduler", {
      enableRemoveDuplicates: false,
      enableRemovePodsViolatingNodeTaints: false,
      enableRemovePodsViolatingInterPodAntiAffinity: false,
      excludeNamespaces: ["keep"],
      useActualUsage: true,
    });
    const policy = valuesOf("descheduler").deschedulerPolicy;
    const [profile] = policy.profiles;
    assert.deepEqual(profile.plugins, {
      deschedule: { enabled: ["RemovePodsViolatingNodeAffinity", "RemovePodsHavingTooManyRestarts"] },
      balance: { enabled: ["LowNodeUtilization"] },
    });
    const [evictor, utilization, restarts, affinity] = profile.pluginConfig;
    assert.deepEqual(profile.pluginConfig.map((plugin: { name: string }) => plugin.name), [
      "DefaultEvictor", "LowNodeUtilization", "RemovePodsHavingTooManyRestarts", "RemovePodsViolatingNodeAffinity",
    ]);
    assert.equal(evictor.args.ignorePvcPods, true);
    assert.deepEqual(restarts.args.namespaces, { exclude: ["keep"] });
    assert.deepEqual(affinity.args.namespaces, { exclude: ["keep"] });
    assert.deepEqual(utilization.args.evictableNamespaces, { exclude: ["keep"] });
    assert.deepEqual(utilization.args.thresholds, { cpu: 20, memory: 20 });
    assert.deepEqual(policy.metricsProviders, [utilization.args.metricsUtilization]);
  });
});
