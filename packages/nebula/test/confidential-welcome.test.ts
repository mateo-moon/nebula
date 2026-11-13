import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ConfidentialWelcome, type ConfidentialWelcomeConfig } from "../src/modules/k8s/confidential-workloads";

const config: ConfidentialWelcomeConfig = { name: "welcome", namespace: "portal-guide", ipAddress: "192.0.2.11",
  acmeEmail: "admin@example.org", acmeClaimName: "welcome-acme-state", nodeSelector: { "kubernetes.io/hostname": "qualification-node" },
  portalUrl: "https://192.0.2.10:9443/", reference: { measurement: "a".repeat(96), initDataSha256: "b".repeat(64),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } } };
function render(value = config) {
  const chart = new Chart(new App(), "welcome");
  const welcome = new ConfidentialWelcome(chart, "guide", value);
  return { url: welcome.url, resources: Testing.synth(chart) };
}

test("welcome owns literal-IP HTTPS and HTTP01 with retained private ACME state and no ingress or cluster credentials", () => {
  const first = render();
  assert.deepEqual(render(), first);
  assert.equal(first.url, "https://192.0.2.11/");
  const resources = first.resources;
  assert.deepEqual(resources.map(value => value.kind).sort(), ["ConfigMap", "Deployment", "NetworkPolicy", "Service"]);
  const site = resources.find(value => value.kind === "ConfigMap")!;
  assert.deepEqual(JSON.parse(site.data["config.json"]), { portalUrl: config.portalUrl, reference: config.reference });
  assert.match(site.data.Caddyfile, /default_sni "192\.0\.2\.11"/);
  assert.match(site.data.Caddyfile, /https:\/\/192\.0\.2\.11 \{/);
  assert.doesNotMatch(site.data.Caddyfile, /https:\/\/192\.0\.2\.11\/ \{/);
  assert.match(site.data.Caddyfile, /dir https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
  assert.match(site.data.Caddyfile, /profile shortlived/);
  assert.match(site.data.Caddyfile, /disable_tlsalpn_challenge/);
  assert.match(site.data.Caddyfile, /reverse_proxy 127\.0\.0\.1:8081/);
  assert.match(site.data.Caddyfile, /admin off/);
  assert.match(site.data.Caddyfile, /exclude http\.log\.access http\.log\.error http\.handlers\.reverse_proxy/);
  assert.doesNotMatch(site.data.Caddyfile, /issuer internal|on_demand|dns |zerossl/i);
  const deployment = resources.find(value => value.kind === "Deployment")!;
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  const pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.fsGroup, 10001);
  assert.deepEqual(pod.nodeSelector, config.nodeSelector);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ["ALL"]);
  assert.match(pod.containers[0].image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(pod.volumes.every((value: any) => value.configMap || value.emptyDir || value.persistentVolumeClaim));
  assert.deepEqual(pod.volumes.find((value: any) => value.name === "acme-state"), {
    name: "acme-state", persistentVolumeClaim: { claimName: config.acmeClaimName } });
  assert.equal(pod.containers[0].volumeMounts.some((value: any) => value.name === "acme-state"), false);
  assert.equal(pod.containers[0].ports, undefined, "Node serves loopback only");
  const caddy = pod.containers.find((value: any) => value.name === "https");
  assert.equal(caddy.image, "docker.io/library/caddy@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0");
  assert.deepEqual(caddy.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(caddy.readinessProbe.httpGet.httpHeaders, [{ name: "Host", value: config.ipAddress }]);
  assert.equal(caddy.readinessProbe.httpGet.scheme, "HTTPS");
  const service = resources.find(value => value.kind === "Service")!;
  assert.deepEqual(service.spec.externalIPs, [config.ipAddress]);
  assert.deepEqual(service.spec.ports, [{ name: "http", port: 80, targetPort: "http" }, { name: "https", port: 443, targetPort: "https" }]);
  assert.equal(service.spec.publishNotReadyAddresses, true, "HTTP01 must work before the first HTTPS certificate exists");
  assert.equal(JSON.stringify(resources).includes("cert-manager.io/"), false);
  assert.equal(JSON.stringify(resources).includes("external-dns.alpha.kubernetes.io/"), false);
  const policy = resources.find(value => value.kind === "NetworkPolicy")!.spec;
  assert.deepEqual(policy.egress[1], { ports: [{ protocol: "TCP", port: 443 }] });
  assert.deepEqual(policy.egress[2], { to: [{ ipBlock: { cidr: "192.0.2.10/32" } }], ports: [{ protocol: "TCP", port: 9443 }] });
  assert.deepEqual(policy.ingress, [{ ports: [{ protocol: "TCP", port: 8080 }, { protocol: "TCP", port: 8443 }] }]);
});

test("literal IPv6 welcome addresses retain IP certificate identity and correct URL syntax", () => {
  const value = render({ ...config, ipAddress: "2001:db8::10" });
  assert.equal(value.url, "https://[2001:db8::10]/");
  const site = value.resources.find(resource => resource.kind === "ConfigMap")!;
  assert.match(site.data.Caddyfile, /default_sni "2001:db8::10"/);
  assert.match(site.data.Caddyfile, /https:\/\/\[2001:db8::10\] \{/);
});

test("explicit stack-owned public routes expose only TNG OHTTP and filtered metadata services", () => {
  const routes = [{ port: 8440, upstream: "http://confidential-operator-access.qualified.svc:8083/" },
    { port: 8441, upstream: "http://preparation.qualified.svc:8445" },
    { port: 8442, upstream: "http://workload-owner.qualified.svc:8445" }];
  const value = render({ ...config, publicOhttpRoutes: routes });
  const site = value.resources.find(resource => resource.kind === "ConfigMap")!;
  for (const route of routes) {
    assert.ok(site.data.Caddyfile.includes(`https://192.0.2.11:${route.port} {`));
    assert.ok(site.data.Caddyfile.includes(`reverse_proxy ${route.upstream.replace(/\/$/, "")}`));
  }
  assert.deepEqual(JSON.parse(site.data["config.json"]), { portalUrl: config.portalUrl, reference: config.reference },
    "Internal route configuration must not enter the public welcome API");
  const service = value.resources.find(resource => resource.kind === "Service")!;
  assert.deepEqual(service.spec.ports.slice(2), routes.map(route => ({ name: `public-${route.port}`, port: route.port, targetPort: `public-${route.port}` })));
  const policy = value.resources.find(resource => resource.kind === "NetworkPolicy")!.spec;
  assert.deepEqual(policy.egress.slice(3).map((rule: any) => rule.ports), [
    [{ protocol: "TCP", port: 8083 }], [{ protocol: "TCP", port: 8445 }], [{ protocol: "TCP", port: 8445 }],
  ], "NetworkPolicy must allow the standard metadata target8083");
  assert.ok(policy.egress.slice(3).every((rule: any) => rule.to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"] === "qualified"));
  for (const route of [
    { port: 443, upstream: routes[0].upstream }, { port: 9443, upstream: routes[0].upstream },
    { port: 8080, upstream: routes[0].upstream }, { port: 8081, upstream: routes[0].upstream },
    { port: 8443, upstream: routes[0].upstream }, { port: 65536, upstream: routes[0].upstream },
    { port: 8441, upstream: "http://owner.qualified.svc:8444" },
    { port: 8441, upstream: "http://trustee.qualified.svc:8080" },
    { port: 8441, upstream: "http://owner.qualified.svc:8447" },
    { port: 8441, upstream: "https://preparation.qualified.svc:8445" },
    { port: 8441, upstream: "http://external.example:8445" },
    { port: 8441, upstream: "http://user:secret@preparation.qualified.svc:8445" },
    { port: 8441, upstream: "http://preparation.qualified.svc:8445/admin" },
    { port: 8441, upstream: "http://preparation.qualified.svc:8445/?token=secret" },
    { port: 8441, upstream: "http://preparation.qualified.svc:8445/#secret" },
  ]) assert.throws(() => render({ ...config, publicOhttpRoutes: [route] }));
  assert.throws(() => render({ ...config, publicOhttpRoutes: [routes[0], routes[0]] }));
  assert.doesNotThrow(() => render({ ...config, publicOhttpRoutes: [{ port: 9454, upstream: routes[0].upstream }] }),
    "A different stack's portal port must not be hardcoded into this module");
  assert.throws(() => render({ ...config, portalUrl: "https://192.0.2.10:9454/", publicOhttpRoutes: [{ port: 9454, upstream: routes[0].upstream }] }));
});

test("same-cluster public-certificate relay uses fixed Service10443 and exact browser namespace/label", () => {
  const portalService = { name: "browser-ui", namespace: "confidential-test" };
  const value = render({ ...config, portalService, publicOhttpRoutes: [{ port: 8440, upstream: "http://confidential-operator-access.confidential-test.svc:8083" }] });
  const site = value.resources.find(resource => resource.kind === "ConfigMap")!;
  assert.deepEqual(JSON.parse(site.data["config.json"]), { portalUrl: config.portalUrl, reference: config.reference,
    certificateOrigin: "https://browser-ui.confidential-test.svc:10443/" });
  const policy = value.resources.find(resource => resource.kind === "NetworkPolicy")!.spec;
  assert.deepEqual(policy.egress[2], { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "confidential-test" } },
    podSelector: { matchLabels: { "confidential.nebula.dev/browser": "browser-ui" } } }], ports: [{ protocol: "TCP", port: 10443 }] });
  assert.equal(policy.egress.flatMap((rule: any) => rule.ports).some((port: any) => port.port === 9443), false);
  assert.deepEqual(policy.egress[3].ports, [{ protocol: "TCP", port: 8083 }]);
  for (const invalid of [{ name: "browser-ui", namespace: "wrong.namespace" }, { name: "wrong/name", namespace: "qualified" },
    { name: "browser-ui", namespace: "qualified", port: 8444 }, { name: "browser-ui" }])
    assert.throws(() => render({ ...config, portalService: invalid as any }));
});

test("welcome refuses secret-bearing and ambiguous public configuration", () => {
  for (const portalUrl of ["http://portal.example.org/", "https://user:secret@portal.example.org/",
    "https://portal.example.org/#token", "https://portal.example.org/?token=secret", "https://portal.example.org/settings"]) {
    assert.throws(() => render({ ...config, portalUrl }));
  }
  for (const extra of [{ token: "secret" }, { ownerKey: "ref+file:///private/key" }, { image: "node:latest" },
    { hostname: "welcome.example.org" }, { ipAddress: "welcome.example.org" }, { ipAddress: "https://192.0.2.11/" },
    { acmeEmail: "admin@example.org\nadmin off" }, { acmeClaimName: "" }, { acmeClaimName: undefined },
    { caddyImage: "caddy:latest" }, { nodeSelector: { "bad key": "value" } }, { nodeSelector: { "kubernetes.io/hostname": "bad value" } },
    { namespace: "wrong/namespace" }]) {
    assert.throws(() => render({ ...config, ...extra } as ConfidentialWelcomeConfig));
  }
  assert.throws(() => render({ ...config, reference: { ...config.reference!, minimumReportedTcb: { microcode: 84 } as any } }));
  assert.throws(() => render({ ...config, reference: { ...config.reference!, releaseUrl: "https://release.example.org/?token=secret" } }));
  assert.throws(() => render({ ...config, reference: { ...config.reference!, releaseUrl: `https://release.example.org/${"a".repeat(2048)}` } }));
});
