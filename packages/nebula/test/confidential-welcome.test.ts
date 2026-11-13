import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ConfidentialWelcome, type ConfidentialWelcomeConfig } from "../src/modules/k8s/confidential-workloads";

const config: ConfidentialWelcomeConfig = { name: "welcome", namespace: "portal-guide", hostname: "welcome.example.org",
  portalUrl: "https://192.0.2.10:9443/", reference: { measurement: "a".repeat(96), initDataSha256: "b".repeat(64),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } } };
function render(value = config) {
  const chart = new Chart(new App(), "welcome");
  const welcome = new ConfidentialWelcome(chart, "guide", value);
  return { url: welcome.url, resources: Testing.synth(chart) };
}

test("welcome is deterministic ordinary HTTPS with no guest, key custody or cluster credentials", () => {
  const first = render();
  assert.deepEqual(render(), first);
  assert.equal(first.url, "https://welcome.example.org/");
  const resources = first.resources;
  assert.deepEqual(resources.map(value => value.kind).sort(), ["ConfigMap", "Deployment", "Ingress", "NetworkPolicy", "Service"]);
  const site = resources.find(value => value.kind === "ConfigMap")!;
  assert.deepEqual(JSON.parse(site.data["config.json"]), { portalUrl: config.portalUrl, reference: config.reference });
  const pod = resources.find(value => value.kind === "Deployment")!.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
  assert.match(pod.containers[0].image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(pod.volumes.every((value: any) => value.configMap || value.emptyDir));
  const ingress = resources.find(value => value.kind === "Ingress")!;
  assert.equal(ingress.metadata.annotations["cert-manager.io/cluster-issuer"], "letsencrypt-prod");
  assert.deepEqual(ingress.spec.tls, [{ hosts: [config.hostname], secretName: "welcome-tls" }]);
  const policy = resources.find(value => value.kind === "NetworkPolicy")!.spec;
  assert.deepEqual(policy.egress[1], { to: [{ ipBlock: { cidr: "192.0.2.10/32" } }], ports: [{ protocol: "TCP", port: 9443 }] });
});

test("welcome refuses secret-bearing and ambiguous public configuration", () => {
  for (const portalUrl of ["http://portal.example.org/", "https://user:secret@portal.example.org/",
    "https://portal.example.org/#token", "https://portal.example.org/?token=secret", "https://portal.example.org/settings"]) {
    assert.throws(() => render({ ...config, portalUrl }));
  }
  for (const extra of [{ token: "secret" }, { ownerKey: "ref+file:///private/key" }, { image: "node:latest" },
    { hostname: "https://welcome.example.org/" }, { namespace: "wrong/namespace" }]) {
    assert.throws(() => render({ ...config, ...extra } as ConfidentialWelcomeConfig));
  }
  assert.throws(() => render({ ...config, reference: { ...config.reference!, minimumReportedTcb: { microcode: 84 } as any } }));
  assert.throws(() => render({ ...config, reference: { ...config.reference!, releaseUrl: "https://release.example.org/?token=secret" } }));
  assert.throws(() => render({ ...config, reference: { ...config.reference!, releaseUrl: `https://release.example.org/${"a".repeat(2048)}` } }));
});
