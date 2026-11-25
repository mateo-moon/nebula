import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { tngTrusteeBootstrapScript } from "../src/modules/k8s/trustee/tng-bootstrap";
import { trusteeSettings } from "../src/modules/k8s/trustee/settings";
import { trusteeConfig } from "./support/trustee";

test("private KBS diagnostics are explicit and preserve the standalone bootstrap", () => {
  for (const owner of [undefined, "synthetic-public-owner"]) {
    const legacy = tngTrusteeBootstrapScript(owner, "synthetic-public-config\n");
    assert.equal(tngTrusteeBootstrapScript(owner, "synthetic-public-config\n", false), legacy);
    assert.match(legacy, /kbs\.toml >\/dev\/null 2>&1\n$/);
    assert.doesNotMatch(legacy, /kbs\.log/);
    const observed = tngTrusteeBootstrapScript(owner, "synthetic-public-config\n", true);
    assert.equal(observed.replace(">/tmp/kbs.log 2>&1", ">/dev/null 2>&1"), legacy,
      "Diagnostics must change only private stderr/stdout capture");
  }
  const config = trusteeConfig();
  const defaultPlan = trusteeSettings(config), explicitLegacy = trusteeSettings(config, { privateDiagnostics: false });
  assert.deepEqual(explicitLegacy, defaultPlan);
  const observed = trusteeSettings(config, { privateDiagnostics: true });
  assert.equal(observed.kbsConfig, defaultPlan.kbsConfig);
  assert.deepEqual(observed.tngConfig, defaultPlan.tngConfig);
  assert.deepEqual(observed.values, defaultPlan.values);
  assert.match(Buffer.from(observed.extensions.args!.join(""), "base64").toString(), />\/tmp\/kbs\.log 2>&1/);
});

test("native public collateral storage is enabled only for an explicitly unified layout", () => {
  const config = trusteeConfig();
  const legacy = trusteeSettings(config);
  assert.equal((parse(legacy.kbsConfig).attestation_service as any).verifier_config, undefined);
  const unified = trusteeSettings(config, { publicCollateral: true });
  assert.deepEqual(JSON.parse(JSON.stringify((parse(unified.kbsConfig).attestation_service as any).verifier_config)),
    { snp_verifier: { vcek_sources: [{ type: "OfflineStore", path: "/run/trustee/public-kds" }] } });
  assert.deepEqual(unified.tngConfig, legacy.tngConfig);
  assert.deepEqual(unified.values, legacy.values);
});
