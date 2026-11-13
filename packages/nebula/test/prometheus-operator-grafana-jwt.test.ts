import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart } from "cdk8s";
import {
  PrometheusOperator,
  grafanaOperatorKubeAuthValues,
  type GrafanaOperatorKubeAuthConfig,
} from "../src/modules/k8s/prometheus-operator";

import { withStubHelm } from "./helm-stub";

const kubeAuth: GrafanaOperatorKubeAuthConfig = {
  issuer: "https://kubernetes.default.svc",
  audience: "operator.grafana.com",
  serviceAccountNamespace: "grafana-operator-system",
  serviceAccountName: "grafana-operator",
  jwksUrl: "https://kubernetes.default.svc/openid/v1/jwks",
};

test("Grafana JWT accepts only the exact operator identity and audience", () => {
  const values = grafanaOperatorKubeAuthValues(kubeAuth) as any;
  const jwt = values.grafana["grafana.ini"]["auth.jwt"];
  assert.equal(jwt.header_name, "Authorization");
  assert.deepEqual(JSON.parse(jwt.expect_claims), {
    iss: kubeAuth.issuer,
    aud: [kubeAuth.audience],
    sub: "system:serviceaccount:grafana-operator-system:grafana-operator",
  });
  assert.equal(jwt.role_attribute_path, "sub == 'system:serviceaccount:grafana-operator-system:grafana-operator' && 'Admin'");
  assert.equal(jwt.role_attribute_strict, true);
  assert.equal(jwt.allow_assign_grafana_admin, false);
  assert.equal(jwt.url_login, false);
  assert.equal(jwt.jwk_set_bearer_token_file, "/var/run/secrets/kubernetes.io/serviceaccount/token");
  assert.equal(jwt.tls_client_ca, "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
});

test("monitoring module adds JWT without changing human Grafana login settings", () => {
  withStubHelm(valuesOf => {
    new PrometheusOperator(new Chart(new App(), "test"), "monitoring", {
      grafanaOperatorKubeAuth: kubeAuth,
      loki: { enabled: false },
      promtail: { enabled: false },
      values: {
        grafana: {
          "grafana.ini": {
            auth: { disable_login_form: true },
            "auth.google": { enabled: true, allowed_domains: "example.com" },
          },
        },
      },
    });
    const ini = valuesOf("prometheus").grafana["grafana.ini"];
    assert.deepEqual(ini.auth, { disable_login_form: true });
    assert.deepEqual(ini["auth.google"], { enabled: true, allowed_domains: "example.com" });
    assert.deepEqual(JSON.parse(ini["auth.jwt"].expect_claims).aud, [kubeAuth.audience]);
  });
});

test("monitoring module rejects a competing raw JWT configuration", () => {
  withStubHelm(() => {
    assert.throws(() => new PrometheusOperator(new Chart(new App(), "test"), "monitoring", {
      grafanaOperatorKubeAuth: kubeAuth,
      loki: { enabled: false },
      promtail: { enabled: false },
      values: { grafana: { "grafana.ini": { "auth.jwt": { role_attribute_strict: false } } } },
    }), /Set Grafana JWT auth through grafanaOperatorKubeAuth/);
  });
});

test("operator identity fields cannot inject a role expression", () => {
  assert.throws(() => grafanaOperatorKubeAuthValues({
    ...kubeAuth, serviceAccountName: "operator' || 'Admin",
  }), /valid Kubernetes identity/);
});
