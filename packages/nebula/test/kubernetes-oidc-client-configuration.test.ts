import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { KubernetesOidcClientConfiguration, kubernetesOidcNativeClientInput, type KubernetesOidcClientConfigurationConfig } from "../src/modules/k8s/kubernetes-access/client-configuration";

const config: KubernetesOidcClientConfigurationConfig = {
  name: "kubectl-example", namespace: "oidc", applicationType: "native",
  issuer: "https://accounts.google.com", clientId: "example.apps.googleusercontent.com",
};

test("native app registration is a ConfigMap without tokens, workloads or access grants", () => {
  const chart = Testing.chart();
  new KubernetesOidcClientConfiguration(chart, "native", { ...config, clientSecret: "example-native-app-value" });
  const objects = Testing.synth(chart);
  assert.equal(objects.length, 1);
  assert.equal(objects[0]!.kind, "ConfigMap");
  assert.deepEqual(objects[0]!.data, { issuer: config.issuer, client_id: config.clientId, client_secret: "example-native-app-value" });
  assert.equal(objects[0]!.metadata.namespace, "oidc");
  assert.equal(objects[0]!.metadata.annotations["nebula.io/oauth-application-type"], "native");
});

test("external registration values remain separately owned map keys", () => {
  const chart = Testing.chart();
  new KubernetesOidcClientConfiguration(chart, "native", config);
  const cm = Testing.synth(chart)[0]!;
  assert.deepEqual(cm.data, { issuer: config.issuer, client_id: config.clientId });
  assert.equal(cm.metadata.annotations["argocd.argoproj.io/sync-options"], "ServerSideApply=true");
  assert.equal(cm.immutable, undefined);
});

test("ConfigMap export produces the exact existing adapter record and binds issuer and client", () => {
  const data = { issuer: config.issuer, client_id: config.clientId, client_secret: "native-value" };
  assert.deepEqual(kubernetesOidcNativeClientInput(config, data), data);
  assert.throws(() => kubernetesOidcNativeClientInput(config, { ...data, issuer: "https://other.example.test" }), /matching/);
  assert.throws(() => kubernetesOidcNativeClientInput(config, { ...data, client_id: "another-client" }), /matching/);
  assert.throws(() => kubernetesOidcNativeClientInput(config, { issuer: config.issuer, client_id: config.clientId }), /only/);
  for (const key of ["refresh_token", "access_token", "id_token", "expires_unix", "password", "client-key-data"]) {
    assert.throws(() => kubernetesOidcNativeClientInput(config, { ...data, [key]: "excluded" }), /only/);
    assert.throws(() => new KubernetesOidcClientConfiguration(Testing.chart(), "bad", { ...config, [key]: "excluded" } as any), /user tokens/);
  }
});

test("confidential clients and invalid registrations fail before rendering", () => {
  const invalid = [
    { applicationType: "web" }, { issuer: "http://accounts.google.com" }, { issuer: "https://example.test/?redirect=other" },
    { clientId: "" }, { clientId: "two clients" }, { clientId: "*" }, { clientSecret: "" }, { clientSecret: "value\n" },
    { name: "bad/name" }, { namespace: "two.names" },
  ];
  for (const change of invalid) assert.throws(() => new KubernetesOidcClientConfiguration(Testing.chart(), "bad", { ...config, ...change } as any));
});

test("each cluster retains its own native client registration", () => {
  const chart = Testing.chart();
  for (const cluster of ["one", "two"]) new KubernetesOidcClientConfiguration(chart, cluster, {
    ...config, name: `kubectl-${cluster}`, clientId: `${cluster}.apps.googleusercontent.com`,
  });
  const objects = Testing.synth(chart);
  assert.deepEqual(objects.map(o => o.metadata.name).sort(), ["kubectl-one", "kubectl-two"]);
  assert.deepEqual(objects.map(o => o.data.client_id).sort(), ["one.apps.googleusercontent.com", "two.apps.googleusercontent.com"]);
});
