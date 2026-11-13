import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ArgoCd } from "../src/modules/k8s/argocd";
import { withStubHelm } from "./helm-stub";

const render = (nebulaPlugin: Record<string, unknown>) => withStubHelm(valuesOf => {
  const chart = new Chart(new App(), "test");
  new ArgoCd(chart, "argocd", { nebulaPlugin: { enabled: true, ...nebulaPlugin } } as any);
  return { objects: Testing.synth(chart), values: valuesOf("argocd") };
});
const admin = (objects: any[]) => objects.filter(o => o.metadata.name === "argocd-nebula-cmp").map(o => o.kind).sort();

test("the plugin's cluster-admin account is created by default and can be left out", () => {
  assert.deepEqual(admin(render({}).objects), ["ClusterRole", "ClusterRoleBinding", "ServiceAccount"]);
  assert.deepEqual(admin(render({ clusterAdminAccount: false }).objects), []);
});

test("the metadata boundary denies instance metadata and admits only link-local DNS", () => {
  const policy = render({ metadataBoundary: { linkLocalDnsServers: ["169.254.20.10"] } }).objects.find(o => o.kind === "NetworkPolicy");
  assert.equal(policy.metadata.name, "argocd-repo-server-metadata-boundary");
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.deepEqual(policy.spec.egress, [
    { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } }] },
    { to: [{ ipBlock: { cidr: "::/0", except: ["fd00:ec2::254/128"] } }] },
    { to: [{ ipBlock: { cidr: "169.254.20.10/32" } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
  ]);
  for (const address of ["169.254.169.254", "10.0.0.2", "169.254.020.10"])
    assert.throws(() => render({ metadataBoundary: { linkLocalDnsServers: [address] } }), /link-local DNS/);
});

test("the AWS identity reaches only the renderer and needs a dedicated repo-server account", () => {
  assert.throws(() => render({ awsWebIdentity: { roleArn: "arn:aws:iam::ACCOUNT:role/renderer", region: "eu-west-1" } }),
    /dedicated repo-server Deployment and ServiceAccount/);
});
