import assert from "node:assert/strict";
import { test } from "node:test";
import { tngTrusteeClientPlan } from "../src/modules/k8s/trustee";
import { identity } from "./support/trustee";

test("client uses local mainline verification with exact VM/workload approval and no trust bypass", () => {
  const plan = tngTrusteeClientPlan(identity(), { host: "127.0.0.1", port: 18443 });
  assert.match(plan.policy, /ev\.init_data == identity\.initDataSha256/);
  assert.match(plan.policy, /ev\.snp\.measurement == identity\.measurement/);
  assert.match(plan.policy, /ev\.snp\.policy_debug_allowed == false/);
  assert.deepEqual(plan.tngConfig.add_ingress[0].verify.policy_ids, ["approved"]);
  assert.equal(plan.tngConfig.add_ingress[0].verify.as_addr, "http://127.0.0.1:18082");
  assert.deepEqual(plan.tngConfig.add_ingress[0].verify.trusted_certs_paths, ["/state/ca.pem"]);
  assert.doesNotMatch(JSON.stringify(plan), /skip_as_token_cert_verify|trust_all|hardware_only/);
  assert.throws(() => tngTrusteeClientPlan({ ...identity(), initDataSha256: "" }, { host: "localhost", port: 8443 }));
  assert.equal(tngTrusteeClientPlan(identity(), { host: "trustee.example.test", port: 443 }).tngConfig.add_ingress[0].mapping.out.port, 443);
  assert.throws(() => tngTrusteeClientPlan(identity(), { host: "localhost", port: 8443 }, 443));
});
