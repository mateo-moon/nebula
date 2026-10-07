import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart } from "cdk8s";
import { OAuth2Proxy, type OAuth2ProxyConfig } from "../src/modules/k8s/oauth2-proxy";
import { Ollama, type OllamaConfig } from "../src/modules/k8s/ollama";
import { declareOllamaModelConfig } from "../src/modules/k8s/kagent/models";
import { KAGENT_WAVE } from "../src/modules/k8s/kagent/crd";

const chart = () => new Chart(new App(), "test");
const auth: OAuth2ProxyConfig = {
  namespace: "auth", name: "login", secretName: "login-credentials", ingressName: "login-callback",
  image: "quay.io/oauth2-proxy/oauth2-proxy:v7.7.1", provider: "google", emailDomains: ["example.com", "example.org"],
  host: "console.example.com", port: 4280, tlsSecretName: "console-tls", ingressClassName: "nginx",
  credentials: { clientId: "example-client", clientSecret: "fixture-client-secret", cookieSecret: "fixture-cookie-secret" },
  annotations: { "argocd.argoproj.io/sync-wave": "1" },
  resources: { requests: { cpu: "10m", memory: "64Mi" }, limits: { memory: "128Mi" } },
};
const inference: OllamaConfig = {
  namespace: "models", name: "inference", image: "ollama/ollama:latest", claimName: "inference-cache",
  storageClassName: "existing-disks", storageSize: "10Gi", port: 12434,
  resources: { limits: { memory: "4Gi" }, requests: { memory: "2Gi" } },
};

test("OAuth2 external auth keeps callback routing, credential references and explicit capacity consistent", () => {
  const target = chart();
  const endpoint = new OAuth2Proxy(target, "auth", auth);
  const [secret, deployment, service, ingress] = target.toJson();
  assert.deepEqual(target.toJson().map(item => item.kind), ["Secret", "Deployment", "Service", "Ingress"]);
  assert.equal(endpoint.authUrl, "http://login.auth.svc.cluster.local:4280/oauth2/auth");
  assert.equal(endpoint.signInUrl, "https://console.example.com/oauth2/start?rd=$escaped_request_uri");
  assert.deepEqual(secret.stringData, { "client-id": "example-client", "client-secret": "fixture-client-secret", "cookie-secret": "fixture-cookie-secret" });
  assert(target.toJson().every(item => item.metadata.namespace === auth.namespace));
  assert(target.toJson().every(item => JSON.stringify(item.metadata.annotations) === JSON.stringify(auth.annotations)));
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(container.args, ["--provider=google", "--email-domain=example.com", "--email-domain=example.org",
    "--http-address=0.0.0.0:4280", "--reverse-proxy=true", "--cookie-secure=true", "--cookie-domain=console.example.com",
    "--whitelist-domain=console.example.com", "--redirect-url=https://console.example.com/oauth2/callback", "--upstream=static://200",
    "--skip-provider-button=true", "--set-xauthrequest=true"]);
  assert.deepEqual(container.env.map((env: any) => env.valueFrom.secretKeyRef), [
    { name: auth.secretName, key: "client-id" }, { name: auth.secretName, key: "client-secret" }, { name: auth.secretName, key: "cookie-secret" },
  ]);
  assert.deepEqual(container.resources, auth.resources);
  assert.deepEqual(container.readinessProbe, { httpGet: { path: "/ping", port: auth.port }, initialDelaySeconds: 5, periodSeconds: 10 });
  assert.deepEqual(service.spec, { selector: { app: auth.name }, ports: [{ name: "http", port: auth.port, targetPort: auth.port }] });
  assert.equal(ingress.metadata.name, auth.ingressName);
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, service.metadata.name);
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.port.number, auth.port);
  assert.deepEqual(ingress.spec.tls, [{ hosts: [auth.host], secretName: auth.tlsSecretName }]);
  assert.equal(deployment.spec.template.metadata.annotations, undefined);
});

test("Ollama shares explicit service and claim identities without adding a model-pull workload", () => {
  const target = chart();
  const endpoint = new Ollama(target, "inference", inference);
  declareOllamaModelConfig(target, "model", { namespace: inference.namespace, name: "embedding", model: "example-embedding", host: endpoint.serviceUrl });
  const [claim, deployment, service, model] = target.toJson();
  assert.deepEqual(target.toJson().map(item => item.kind), ["PersistentVolumeClaim", "Deployment", "Service", "ModelConfig"]);
  assert.equal(endpoint.serviceUrl, "http://inference.models.svc.cluster.local:12434");
  assert.deepEqual(claim.spec, { accessModes: ["ReadWriteOnce"], storageClassName: inference.storageClassName, resources: { requests: { storage: inference.storageSize } } });
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.template.spec, {
    containers: [{ name: inference.name, image: inference.image, ports: [{ containerPort: inference.port }], resources: inference.resources,
      volumeMounts: [{ name: "models", mountPath: "/root/.ollama" }] }],
    volumes: [{ name: "models", persistentVolumeClaim: { claimName: inference.claimName } }],
  });
  assert.deepEqual(service.spec, { type: "ClusterIP", selector: { app: inference.name }, ports: [{ port: inference.port, targetPort: inference.port }] });
  assert.deepEqual(model.spec, { provider: "Ollama", model: "example-embedding", ollama: { host: endpoint.serviceUrl } });
  assert.equal(model.metadata.annotations["argocd.argoproj.io/sync-wave"], String(KAGENT_WAVE.DEPENDENCY));
});

test("service constructors reject invalid endpoints and empty authentication domain policy", () => {
  for (const port of [0, 65536, 1.5]) {
    assert.throws(() => new OAuth2Proxy(chart(), "bad", { ...auth, port }), /port/);
    assert.throws(() => new Ollama(chart(), "bad", { ...inference, port }), /port/);
  }
  assert.throws(() => new OAuth2Proxy(chart(), "bad", { ...auth, emailDomains: [] }), /emailDomains/);
  assert.throws(() => new OAuth2Proxy(chart(), "bad", { ...auth, host: "example.com/path" }), /plain names/);
});
