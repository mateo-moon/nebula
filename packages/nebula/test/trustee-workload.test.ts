import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { gzipSync } from "fflate";
import { trusteeClientSidecars, generateAttestedWorkloadPolicy } from "../src/modules/k8s/trustee/workload";
import { deterministicInitData } from "../src/modules/k8s/trustee/genpolicy";
import { initDataDocument } from "../src/modules/k8s/confidential-guests/measured";
import { identity, trusteeConfig } from "./support/trustee";

const sidecars = () => trusteeClientSidecars({ identity: identity(), target: { host: "trustee.keys.svc", port: 8443 },
  verifierImage: `example.test/as@sha256:${"a".repeat(64)}`, tngImage: `example.test/tng@sha256:${"b".repeat(64)}` });
const script = (container: any) => Buffer.from(container.args.join(""), "base64").toString();
test("guest client starts its private verifier before opening the KBS transport", () => {
  const plan = sidecars(), [as, tng] = plan.initContainers;
  assert.deepEqual(plan.initContainers.map(c => c.restartPolicy), ["Always", "Always"]);
  assert.equal(plan.kbsUrl, "http://127.0.0.1:18080");
  assert.match(script(as), /--socket 127\.0\.0\.1:18082/);
  assert.match(script(as), /rm -f ca\.key/);
  assert.match(script(tng), /until curl .*http:\/\/127\.0\.0\.1:18082/);
  assert.match(script(tng), /exec tng launch/);
  assert.deepEqual(tng.startupProbe, { tcpSocket: { port: 18080 }, periodSeconds: 2, failureThreshold: 60 });
  for (const container of plan.initContainers) {
    execFileSync("/bin/sh", ["-n"], { input: script(container) });
    assert.equal(container.securityContext.runAsUser, 10001);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities, { drop: ["ALL"] });
  }
  assert.ok(plan.volumes.every(v => v.emptyDir.medium === "Memory"));
  assert.throws(() => trusteeClientSidecars({ identity: identity(), target: { host: "trustee", port: 8443 },
    verifierImage: "example.test/as:latest", tngImage: tng.image }), /digest-pinned/);
});

test("native workload generation refuses host injection before invoking genpolicy", () => {
  const client = sidecars();
  const pod = { apiVersion: "v1", kind: "Pod", spec: {
    runtimeClassName: "kata-qemu-snp", automountServiceAccountToken: false, enableServiceLinks: false,
    initContainers: client.initContainers, containers: [{ ...client.initContainers[0], name: "app", restartPolicy: undefined }],
    volumes: client.volumes,
  } };
  const mutate = (change: (copy: any) => void) => { const copy = structuredClone(pod); change(copy); return copy; };
  for (const candidate of [
    mutate(p => p.spec.hostNetwork = true), mutate(p => p.spec.runtimeClassName = "runc"),
    mutate(p => p.spec.automountServiceAccountToken = true), mutate(p => p.spec.containers[0].securityContext.privileged = true),
    mutate(p => p.spec.containers[0].securityContext.capabilities.add = ["SYS_ADMIN"]),
    mutate(p => p.spec.volumes[0] = { name: "state", secret: { secretName: "host-policy" } }),
    mutate(p => p.spec.containers[0].env = [{ name: "KEY", valueFrom: { secretKeyRef: { name: "key", key: "value" } } }]),
    mutate(p => p.spec.initContainers[0].restartPolicy = undefined),
  ]) assert.throws(() => generateAttestedWorkloadPolicy(candidate, { "aa.toml": "", "cdh.toml": "" }, trusteeConfig()),
    /requires|Invalid|Only persistent/);
});

test("deterministic InitData preserves native CDH and policy bytes", () => {
  const data = { "cdh.toml": '[kbc]\nurl = "http://127.0.0.1:18080"\n', "aa.toml": '[log]\nlevel="off"\n', "policy.rego": "package agent_policy\n" };
  const input = Buffer.from(gzipSync(Buffer.from(stringify({ algorithm: "sha256", data, version: "0.1.0" })))).toString("base64");
  const output = deterministicInitData(input, ["aa.toml", "cdh.toml"]);
  assert.deepEqual({ ...(parse(initDataDocument(output).toString()) as any).data }, data);
  assert.equal(deterministicInitData(output, ["cdh.toml", "aa.toml"]), output);
  assert.throws(() => deterministicInitData(input), /unexpected native Init-Data/);
});
