import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Testing, type Chart } from "cdk8s";
import { evaluate } from "@marcbachmann/cel-js";
import { K0SmotronControlPlaneV1Beta2SpecStorageType } from "../imports/controlplane.cluster.x-k8s.io";
import { parse, stringify } from "yaml";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "../src/modules/k8s/kubernetes-access/identity";
import { KubernetesWorkloadIdentity, KubernetesWorkloadKubeconfig, PROJECTED_TOKEN_EXEC_CREDENTIAL_COMMAND } from "../src/modules/k8s/kubernetes-access/workload-identity";
import { KubernetesOidcGateway } from "../src/modules/k8s/kubernetes-access/gateway";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { K0sCluster, type K0sInfraProvider } from "../src/modules/infra/k0s/cluster";
import { AwsK0sCluster } from "../src/modules/infra/aws/k0s-cluster";
import { ArgoCdOidcCluster } from "../src/modules/k8s/argocd/oidc-cluster";
import { ClusterAutoscaler, clusterAutoscalerValues } from "../src/modules/k8s/cluster-autoscaler";
import { ServiceAccountTokenRotation } from "../src/modules/k8s/kubernetes-access/token-rotation";
import { ServiceAccountTokenLifetimePolicy } from "../src/modules/k8s/kubernetes-access/token-lifetime-policy";
import { K0sOidcAuthentication } from "../src/modules/infra/k0s/oidc-authentication";

const identity: KubernetesOidcIdentityConfig = {
  cluster: "example", hostname: "api.example.test",
  workforce: { url: "https://login.example.test", jwksUrl: "https://login.example.test/keys", audience: "kubernetes:example", emailDomain: "example.test" },
  workload: { url: "https://workload.example.test", jwksUrl: "https://workload.example.test/keys", audience: "kubernetes:example", subjects: ["system:serviceaccount:gitops:controller"] },
};
const gateway = {
  ...identity, namespace: "default", ingressClassName: "nginx", clusterIssuer: "public-tls",
  backend: { host: "api.internal.example.test", port: 30443, serverName: "api.internal.example.test", caSecret: { name: "example-ca", key: "tls.crt" } },
};
const provider: K0sInfraProvider<object> = {
  infraClusterApiGroup: "infrastructure.cluster.x-k8s.io", infraClusterKind: "RemoteCluster", emitInfraCluster: () => { },
  emitMachineTemplate: (_s, _i, c) => ({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta1", kind: "RemoteMachineTemplate", name: c.baseName })
};
test("identity requires exact audiences and verified workforce without gateway bindings", () => {
  const i = new KubernetesOidcIdentity(identity);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...identity.workforce, url: "http://login.example.test" } }), /HTTPS/);
  for (const audience of ["", "*", "two audiences"])
    assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...identity.workforce, audience } }), /exact.*audience/);
  const custom = new KubernetesOidcIdentity({ ...identity, workload: { ...identity.workload!, audience: "urn:example:target-api", maxTokenLifetimeSeconds: 1200 } });
  assert.equal(custom.workloadIdentity.projection.volume.projected.sources[0]!.serviceAccountToken.audience, "urn:example:target-api");
  assert.equal(custom.workloadIdentity.expirationSeconds, 1200);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workload: { ...identity.workload!, subjects: ["system:serviceaccount:*:*"] } }), /exact ServiceAccount/);
  const auth: any = i.authenticationConfiguration();
  assert.equal(auth.anonymous, undefined); assert.deepEqual(auth.jwt[0].issuer.audiences, ["kubernetes:example"]);
  assert.equal(auth.jwt[0].claimMappings.groups, undefined); assert.equal(auth.jwt[1].claimMappings.groups, undefined);
  assert.ok(auth.jwt[1].claimValidationRules.some((r: any) => r.expression.includes("pod.uid")));
  for (const config of [i.userKubeconfig(), i.workloadKubeconfig()]) assert.ok(!/client-certificate|client-key|insecure-skip-tls-verify|client-secret/.test(JSON.stringify(config)));
  const server: any = i.userKubeconfig({ command: "/usr/local/bin/oidc-login", grantType: "device-code", tokenCacheStorage: "disk", tokenCacheDirectory: "/run/login" });
  assert.equal(server.users[0].user.exec.command, "/usr/local/bin/oidc-login"); assert.ok(server.users[0].user.exec.args.includes("--grant-type=device-code"));
});

test("identity mappings belong to the caller and reserve Kubernetes system identities", () => {
  const workforce = { ...identity.workforce, emailDomain: undefined, username: { claim: "sub", prefix: "people:" }, groups: { claim: "roles", prefix: "roles:" } };
  const auth: any = new KubernetesOidcIdentity({ ...identity, workforce }).authenticationConfiguration();
  assert.deepEqual(auth.jwt[0].claimMappings.username, { claim: "sub", prefix: "people:" });
  assert.deepEqual(auth.jwt[0].claimMappings.groups, { claim: "roles", prefix: "roles:" });
  assert.ok(!auth.jwt[0].claimValidationRules.some((r: any) => r.expression?.includes("email")));
  assert.ok(auth.jwt[0].userValidationRules.some((r: any) => r.expression.includes("user.groups.all")));
  const fixed: any = new KubernetesOidcIdentity({ ...identity, workforce: { ...identity.workforce, groups: ["access:developers"] } }).authenticationConfiguration();
  assert.equal(fixed.jwt[0].claimMappings.groups.expression, '["access:developers"]');
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...workforce, groups: ["system:masters"] } }), /non-system/);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...workforce, username: { claim: "sub", prefix: "system:" } } }), /non-system/);
});

test("email groups extend fixed groups for exact verified emails only", () => {
  const emailGroups = { "access:maintainers": ["maintainer@example.test", "lead@example.test"], "access:auditors": ["auditor@example.test"] };
  const config = (workforce: Partial<KubernetesOidcIdentityConfig["workforce"]>) => ({ ...identity, workforce: { ...identity.workforce, ...workforce } });
  const workforce = (overrides: Partial<KubernetesOidcIdentityConfig["workforce"]>) => (new KubernetesOidcIdentity(config(overrides)).authenticationConfiguration() as any).jwt[0];
  const expression = workforce({ groups: ["access:developers"], emailGroups }).claimMappings.groups.expression;
  assert.equal(expression, '["access:developers"] + (claims.email in ["maintainer@example.test","lead@example.test"] ? ["access:maintainers"] : [])'
    + ' + (claims.email in ["auditor@example.test"] ? ["access:auditors"] : [])');
  const groups = (email: string, source = expression) => evaluate(source, { claims: { email } });
  assert.deepEqual(groups("lead@example.test"), ["access:developers", "access:maintainers"]);
  assert.deepEqual(groups("auditor@example.test"), ["access:developers", "access:auditors"]);
  for (const email of ["employee@example.test", "Lead@example.test", "lead@example.test.elsewhere.test", "other+lead@example.test"])
    assert.deepEqual(groups(email), ["access:developers"]);
  assert.throws(() => evaluate(expression, { claims: {} }), /email/);
  const alone = workforce({ emailGroups: { "access:auditors": ["auditor@example.test"] } }).claimMappings.groups.expression;
  assert.equal(alone, '[] + (claims.email in ["auditor@example.test"] ? ["access:auditors"] : [])');
  assert.deepEqual(groups("auditor@example.test", alone), ["access:auditors"]); assert.deepEqual(groups("employee@example.test", alone), []);
  assert.equal(workforce({ emailGroups: {} }).claimMappings.groups, undefined);
  // Membership never follows an unverified address, whichever claim names the user.
  const bySubject = workforce({ emailDomain: undefined, username: { claim: "sub" }, emailGroups });
  assert.ok(bySubject.claimValidationRules.some((r: any) => r.expression === "claims.email_verified == true"));
  const chart = Testing.chart();
  new K0smotronCluster(chart, "cluster", { name: "example", k8sVersion: "v1.35.0", provider, controlPlane: { authentication: { identity: config({ groups: ["access:developers"], emailGroups }) } } });
  const hosted = Testing.synth(chart).find(o => o.kind === "ConfigMap" && o.metadata.name === "oidc-example-authentication")!;
  assert.equal(parse(hosted.data["authentication.yaml"]).jwt[0].claimMappings.groups.expression, expression);
  assert.throws(() => new KubernetesOidcIdentity(config({ groups: { claim: "roles" }, emailGroups })), /not a claim mapping/);
  const refused: Record<string, readonly string[]>[] = [
    { "system:masters": ["lead@example.test"] }, { "": ["lead@example.test"] }, { "access:auditors": [] }, { "access:auditors": ["lead"] },
    { "access:auditors": ["lead@example.test "] }, { "access:auditors": ["lead@example.test,auditor@example.test"] }, { "access:auditors": ['lead"@example.test'] },
  ];
  for (const groups of refused) assert.throws(() => new KubernetesOidcIdentity(config({ emailGroups: groups })), /non-system group name and exact email/);
});

test("public workforce clients support provider claims and one-hour humans without extending workload trust", () => {
  const audience = "example-desktop-client-id";
  const config: KubernetesOidcIdentityConfig = { ...identity, workforce: {
    url: "https://accounts.google.com", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs", audience,
    emailDomain: "example.test", maxTokenLifetimeSeconds: 3600,
    requiredClaims: { hd: "example.test", azp: audience },
    login: { grantType: "authcode", clientAuthentication: "client-secret", extraScopes: ["email"], authRequestExtraParams: { access_type: "offline", prompt: "consent", hd: "example.test" } },
  } };
  const i = new KubernetesOidcIdentity(config);
  const auth: any = i.authenticationConfiguration();
  assert.deepEqual(auth.jwt[0].issuer.audiences, [audience]);
  assert.ok(auth.jwt[0].claimValidationRules.some((r: any) => r.expression?.includes("<= 3600")));
  assert.ok(auth.jwt[0].claimValidationRules.some((r: any) => r.claim === "hd" && r.requiredValue === "example.test"));
  assert.ok(auth.jwt[0].claimValidationRules.some((r: any) => r.claim === "azp" && r.requiredValue === audience));
  assert.ok(auth.jwt[1].claimValidationRules.some((r: any) => r.expression.includes("<= 600")));
  const profile: any = i.userKubeconfig(), args = profile.users[0].user.exec.args;
  for (const expected of ["--grant-type=authcode", "--oidc-extra-scope=email", "--oidc-pkce-method=S256", "--token-cache-storage=keyring", "--oidc-auth-request-extra-params=access_type=offline", "--oidc-auth-request-extra-params=hd=example.test"])
    assert.ok(args.includes(expected));
  assert.ok(!args.includes("--oidc-extra-scope=offline_access"));
  assert.equal(profile.users[0].user.exec.command, "nebula-oidc-login");
  assert.ok(args.includes("--oidc-client-secret-file=~/.config/nebula/oidc/example.json"));
  assert.ok(!args.some((arg: string) => arg.startsWith("--oidc-client-secret=")));
  const headless: any = i.userKubeconfig({ command: "/usr/local/bin/nebula-oidc-login", clientCredentialFile: "/run/oidc/example.json", skipOpenBrowser: true, redirectUrl: "http://127.0.0.1:8000/", listenAddress: "127.0.0.1:8000" });
  assert.ok(headless.users[0].user.exec.args.includes("--skip-open-browser"));
  assert.ok(headless.users[0].user.exec.args.includes("--oidc-client-secret-file=/run/oidc/example.json"));
  assert.throws(() => i.userKubeconfig({ redirectUrl: "http://public.example.test/" }), /loopback/);
  assert.throws(() => i.userKubeconfig({ listenAddress: "0.0.0.0:8000" }), /loopback/);
  assert.throws(() => new KubernetesOidcIdentity({ ...config, workload: { ...config.workload!, maxTokenLifetimeSeconds: 300 } }), /at least 600/);
  for (const maxTokenLifetimeSeconds of [0, -1, 3601, 1.5, Infinity])
    assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, maxTokenLifetimeSeconds } }), /lifetime/);
  const invalidParams: Record<string, string>[] = [{ code_challenge_method: "plain" }, { client_secret: "forbidden" }, { prompt: "consent,scope=anything" }];
  for (const authRequestExtraParams of invalidParams)
    assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, login: { authRequestExtraParams } } }), /protocol security/);
  assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, requiredClaims: { "hd) || true": "example.test" } } }), /exact claim/);
  const chart = Testing.chart(); new KubernetesOidcGateway(chart, "google", { ...gateway, ...config });
  const envoy = parse(Testing.synth(chart).find(o => o.kind === "ConfigMap")!.data["envoy.yaml"]);
  const hcm = envoy.static_resources.listeners[0].filter_chains[0].filters[0].typed_config;
  assert.equal(hcm.http_filters[0].typed_config.providers.workforce.max_lifetime, "3600s");
  assert.equal(hcm.http_filters[0].typed_config.providers.workload.max_lifetime, "600s");
  assert.equal(hcm.route_config.virtual_hosts[0].routes[0].route.max_stream_duration.max_stream_duration, "600s");
});

test("gateway verifies every bearer and backend TLS and mounts public CA only", () => {
  const chart = Testing.chart(); new KubernetesOidcGateway(chart, "gateway", { ...gateway, podLabels: { app: "example-api" }, maxStreamDurationSeconds: 900 });
  const objects = Testing.synth(chart), deployment = objects.find(o => o.kind === "Deployment")!, pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false); assert.deepEqual(deployment.spec.selector.matchLabels, { app: "example-api" });
  assert.deepEqual(pod.volumes.find((v: any) => v.name === "backend-ca").secret.items, [{ key: "tls.crt", path: "ca.crt" }]);
  const config = parse(objects.find(o => o.kind === "ConfigMap")!.data["envoy.yaml"]), hcm = config.static_resources.listeners[0].filter_chains[0].filters[0].typed_config;
  const jwt = hcm.http_filters[0].typed_config; assert.deepEqual(jwt.rules[0].match, { prefix: "/" }); assert.ok(!JSON.stringify(jwt.rules).includes("allow_missing"));
  for (const p of Object.values(jwt.providers) as any[]) { assert.equal(p.forward, true); assert.equal(p.max_lifetime, "600s"); assert.equal(p.require_expiration, true); }
  assert.equal(hcm.route_config.virtual_hosts[0].routes[0].route.max_stream_duration.max_stream_duration, "900s");
  assert.ok(hcm.http_filters[1].typed_config.default_source_code.inline_string.includes('^impersonate%-'));
  assert.ok(!JSON.stringify(config).includes("tls_certificates")); assert.ok(!JSON.stringify(hcm.access_log).includes("PATH"));
  assert.ok(!objects.some(o => ["ServiceAccount", "ClusterRoleBinding"].includes(o.kind)));
});

test("native hosted auth composes with workers, datastore settings and repeated service-account issuers", () => {
  const render = (authentication?: any) => {
    const chart = Testing.chart();
    new K0smotronCluster(chart, "cluster", {
      name: "example", k8sVersion: "v1.35.0", provider, workerPools: { workers: { machine: {}, replicas: 2 } }, controlPlane: {
        authentication, storage: { type: K0SmotronControlPlaneV1Beta2SpecStorageType.ETCD, etcd: { image: "quay.io/k0sproject/etcd:v3.5.13", autoDeletePvCs: false } },
        apiExtraArgs: { "service-account-issuer": "https://workload.example.test" },
        apiRawArgs: ["--service-account-issuer=https://issuer-a.example.test", "--service-account-issuer=https://issuer-b.example.test"], serviceAnnotations: { example: "true" },
      }
    }); return Testing.synth(chart);
  };
  const before = render(), prepared = render({ identity }), cp = prepared.find(o => o.kind === "K0smotronControlPlane")!;
  const workers = (objects: any[]) => objects.filter(o => ["K0sWorkerConfigTemplate", "MachineDeployment"].includes(o.kind));
  assert.deepEqual(workers(prepared), workers(before)); assert.equal(cp.spec.storage.etcd.image, "quay.io/k0sproject/etcd:v3.5.13"); assert.equal(cp.spec.storage.etcd.autoDeletePVCs, false);
  assert.equal(cp.spec.k0sConfig.spec.api.extraArgs["anonymous-auth"], "false");
  assert.deepEqual(cp.spec.k0sConfig.spec.api.rawArgs, ["--service-account-issuer=https://issuer-a.example.test", "--service-account-issuer=https://issuer-b.example.test"]);
  assert.ok(!prepared.some(o => ["NetworkPolicy", "Job"].includes(o.kind)));
  assert.deepEqual(cp.spec.patches, before.find(o => o.kind === "K0smotronControlPlane")!.spec.patches);
  const auth = new K0sOidcAuthentication(Testing.chart(), "auth", { identity });
  for (const flag of ["oidc-issuer-url", "authentication-config", "anonymous-auth"]) {
    assert.throws(() => auth.api({ [flag]: "value" }), /Configure OIDC through authentication/);
    assert.throws(() => auth.api(undefined, [`--${flag}`, "value"]), /Configure OIDC through authentication/);
    assert.throws(() => auth.api(undefined, [`--${flag}=value`]), /Configure OIDC through authentication/);
  }
});

test("standalone cloud and bare-metal composition share files and retain service-account issuer", () => {
  for (const type of ["generic", "aws"]) {
    const chart = Testing.chart();
    const authentication = { identity };
    if (type === "generic") new K0sCluster(chart, "standalone", { name: "example", k8sVersion: "v1.35.0", provider, controlPlane: { machine: {}, authentication }, oidcIssuer: { issuerUrl: "https://native.example.test" } });
    else new AwsK0sCluster(chart, "standalone", { name: "example", k8sVersion: "v1.35.0", region: "eu-central-1", controlPlane: { authentication }, oidcIssuer: { issuerUrl: "https://native.example.test" } });
    const cp = Testing.synth(chart).find(o => o.kind === "K0sControlPlane")!;
    assert.equal(cp.spec.k0sConfigSpec.k0s.spec.api.extraArgs["service-account-issuer"], "https://native.example.test");
    assert.deepEqual(cp.spec.k0sConfigSpec.files.map((f: any) => f.path), ["/etc/kubernetes-oidc/authentication.yaml"]);
  }
});

test("authentication manifests use the control-plane namespace and compose caller RBAC", () => {
  const bootstrapManifests = [{ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "example-reader" }, rules: [] }];
  const chart = Testing.chart();
  new K0smotronCluster(chart, "cluster", { name: "example", namespace: "hosting", k8sVersion: "v1.35.0", provider, controlPlane: { authentication: { identity, bootstrapManifests } } });
  const objects = Testing.synth(chart), configMaps = objects.filter(o => o.kind === "ConfigMap");
  assert.equal(configMaps.length, 2);
  assert.ok(configMaps.every(o => o.metadata.namespace === "hosting"));
  assert.deepEqual(parse(configMaps.find(o => o.data["access.yaml"])!.data["access.yaml"]), bootstrapManifests[0]);
  assert.equal(objects.find(o => o.kind === "K0smotronControlPlane")!.spec.manifests[0].configMap.name, "oidc-example-authentication-rbac");
  const standalone = new K0sOidcAuthentication(Testing.chart(), "auth", { identity, bootstrapManifests }).standalone();
  assert.deepEqual(parse(standalone.files[1]!.content), bootstrapManifests[0]);
});

test("Argo and autoscaler share rotating file identity and only declare their own resources", () => {
  const chart = Testing.chart(), token = new KubernetesWorkloadIdentity({ cluster: "example" });
  new ArgoCdOidcCluster(chart, "argo", { name: "example", server: "https://api.example.test", identity: { cluster: "example" } });
  new KubernetesWorkloadKubeconfig(chart, "client", { name: "example-oidc", namespace: "default", server: "https://api.example.test", identity: { cluster: "example" } });
  const objects = Testing.synth(chart); assert.ok(objects.every(o => o.kind === "Secret")); assert.ok(!/client-certificate|client-key|bearerToken|certData|keyData/.test(JSON.stringify(objects)));
  assert.equal(parse(objects.find(o => o.metadata.name === "example-oidc")!.stringData.value).users[0].user.tokenFile, token.tokenPath);
  const values: any = clusterAutoscalerValues({ clusterName: "example", workloadIdentity: { cluster: "example" }, workloadKubeconfigSecret: "example-oidc" });
  assert.equal(values.clusterAPIKubeconfigSecret, "example-oidc"); assert.deepEqual(values.extraVolumes, [token.projection.volume]);
  assert.deepEqual(values.securityContext, { fsGroup: 65532 });
  const plain: any = clusterAutoscalerValues({ clusterName: "example" });
  assert.equal(plain.extraVolumes, undefined); assert.equal(plain.securityContext, undefined);
  assert.throws(() => KubernetesWorkloadIdentity.podSpec([{ cluster: "example" }, { cluster: "example" }]), /Duplicate/);
});

test("exec credential rereads rotated tokens and rejects malformed content", () => {
  const work = mkdtempSync(join(tmpdir(), "nebula-oidc-")), file = join(work, "token");
  try {
    writeFileSync(join(work, "date"), `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(new Date(Date.now()+30000).toISOString().replace(/\\.\\d{3}Z$/,"Z"))'\n`, { mode: 0o755 });
    const run = () => JSON.parse(execFileSync("sh", ["-ec", PROJECTED_TOKEN_EXEC_CREDENTIAL_COMMAND, "fixture", file], { encoding: "utf8", env: { ...process.env, PATH: `${work}:${process.env.PATH}` } }));
    writeFileSync(file, "first.test.signature"); assert.equal(run().status.token, "first.test.signature"); writeFileSync(file, "rotated.test.signature"); assert.equal(run().status.token, "rotated.test.signature"); writeFileSync(file, 'unsafe"token'); assert.throws(run);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("token rotation names exact targets and holds credentials on tmpfs", () => {
  const chart = Testing.chart(); new ServiceAccountTokenRotation(chart, "rotation", { name: "token-rotation", namespace: "default", targetNamespace: "apps", targets: [{ serviceAccount: "consumer", secret: "consumer-token" }], identity: { cluster: "example" }, kubeconfigSecret: "example-oidc", caSecret: { name: "example-ca", key: "tls.crt" }, expirationSeconds: 1200 });
  const pod = Testing.synth(chart).find(o => o.kind === "CronJob")!.spec.jobTemplate.spec.template.spec;
  assert.equal(pod.volumes.find((v: any) => v.name === "work").emptyDir.medium, "Memory"); assert.equal(pod.automountServiceAccountToken, false);
  const script = pod.containers[0].args[0];
  assert.ok(script.includes("consumer:consumer-token")); assert.ok(script.includes("--duration=1200s"));
  assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
  const work = mkdtempSync(join(tmpdir(), "nebula-rotation-"));
  try {
    // A missing target must fail the job instead of reporting successful rotation.
    writeFileSync(join(work, "kubectl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.notEqual(spawnSync("sh", ["-ec", script], { env: { ...process.env, PATH: `${work}:${process.env.PATH}` } }).status, 0);
  } finally { rmSync(work, { recursive: true, force: true }); }
  const policy: any = ServiceAccountTokenLifetimePolicy.manifests({ name: "token-lifetime", requesterUsername: "workload:example", maxTokenLifetimeSeconds: 1200 })[0];
  assert.ok(policy.spec.validations[0].expression.includes("<= 1200"));
  assert.throws(() => ServiceAccountTokenLifetimePolicy.manifests({ name: "token-lifetime", requesterUsername: "", maxTokenLifetimeSeconds: 1200 }), /requester username/);
});

test("token rotation requests only configured audiences without shell expansion", () => {
  const config = {
    name: "token-rotation", namespace: "default", targetNamespace: "apps",
    targets: [{ serviceAccount: "consumer", secret: "consumer-token" }],
    identity: { cluster: "example" }, kubeconfigSecret: "example-oidc",
    caSecret: { name: "example-ca", key: "tls.crt" },
  };
  const audiences = ["https://api.example.test", "urn:example:'$(printf${IFS}expanded)"];
  const chart = Testing.chart(); new ServiceAccountTokenRotation(chart, "rotation", { ...config, audiences });
  const script = Testing.synth(chart).find(o => o.kind === "CronJob")!.spec.jobTemplate.spec.template.spec.containers[0].args[0];
  const create = script.split("\n").find((line: string) => line.includes(" create token "))!.split(" > /work/token")[0];
  const work = mkdtempSync(join(tmpdir(), "nebula-token-audiences-"));
  try {
    writeFileSync(join(work, "kubectl"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const args = JSON.parse(execFileSync("sh", ["-ec", `service_account=consumer; ${create}`], { encoding: "utf8", env: { ...process.env, PATH: `${work}:${process.env.PATH}` } }));
    assert.deepEqual(args, ["--cache-dir=/work/cache", "-n", "apps", "create", "token", "consumer", "--duration=600s", ...audiences.map(audience => `--audience=${audience}`)]);
  } finally { rmSync(work, { recursive: true, force: true }); }
  for (const audiences of [[], ["same", "same"], [""], ["*"], ["two audiences"], ["line\nbreak"]])
    assert.throws(() => new ServiceAccountTokenRotation(Testing.chart(), "invalid", { ...config, audiences }), /audience/);
  const defaults = Testing.chart(); new ServiceAccountTokenRotation(defaults, "rotation", config);
  assert.ok(!Testing.synth(defaults).find(o => o.kind === "CronJob")!.spec.jobTemplate.spec.template.spec.containers[0].args[0].includes("--audience="));
});

test("Argo and Crossplane consume shared projections through their own configuration", async () => {
  const { ArgoCd } = await import("../src/modules/k8s/argocd");
  const { Crossplane } = await import("../src/modules/k8s/crossplane");
  const { readFileSync } = await import("node:fs");
  const work = mkdtempSync(join(tmpdir(), "nebula-oidc-helm-")), values = join(work, "values.yaml"), rendered = join(work, "argo-cd.yaml"), previous = process.env.PATH;
  writeFileSync(join(work, "helm"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('-f'))fs.copyFileSync(args[args.indexOf('-f')+1],${JSON.stringify(values)});if(args.at(-1)==='argo-cd')process.stdout.write(fs.readFileSync(${JSON.stringify(rendered)}));\n`, { mode: 0o755 });
  // Stands in for the chart: its server, controller and repo server under their configured names, the
  // token volumes rendered on the first `mounting` of them, and the one Pod security context they share.
  const token = new KubernetesWorkloadIdentity({ cluster: "example" }).projection.volume;
  const renderArgo = (config: ConstructorParameters<typeof ArgoCd>[2], chart: { names?: string[]; mounting?: number; securityContext?: object } = {}) => {
    const [server = "argocd-server", controller = "argocd-application-controller"] = chart.names ?? [];
    const mounting = chart.mounting ?? (config?.workloadIdentities?.length ? 2 : 0);
    writeFileSync(rendered, [["Deployment", server], ["StatefulSet", controller], ["Deployment", "argocd-repo-server"]].map(([kind, name], index) => stringify({
      apiVersion: "apps/v1", kind, metadata: { name },
      spec: { template: { spec: { ...(chart.securityContext ? { securityContext: chart.securityContext } : {}), volumes: [{ name: "tmp", emptyDir: {} }, ...(index < mounting ? [token] : [])], containers: [] } } },
    })).join("---\n"));
    const argo = new ArgoCd(Testing.chart(), "argo", config);
    return Object.fromEntries(argo.helm.apiObjects.map(o => [o.name, o.toJson().spec.template.spec.securityContext]));
  };
  const identities = { workloadIdentities: [{ cluster: "example" }] };
  process.env.PATH = `${work}:${previous}`;
  try {
    const fileGroups = renderArgo({ ...identities, values: { controller: { volumes: [{ name: "existing", emptyDir: {} }] } } });
    const argoValues = parse(readFileSync(values, "utf8"));
    for (const component of ["controller", "server"]) assert.ok(argoValues[component].volumes.some((v: any) => v.name === "oidc-example"));
    assert.ok(argoValues.controller.volumes.some((v: any) => v.name === "existing"));
    assert.deepEqual(fileGroups, { "argocd-server": { fsGroup: 999 }, "argocd-application-controller": { fsGroup: 999 }, "argocd-repo-server": undefined });
    assert.deepEqual(renderArgo(identities, { names: ["argocd-api", "gitops-controller"] }), { "argocd-api": { fsGroup: 999 }, "gitops-controller": { fsGroup: 999 }, "argocd-repo-server": undefined });
    assert.deepEqual(renderArgo({}), { "argocd-server": undefined, "argocd-application-controller": undefined, "argocd-repo-server": undefined });
    const nonRoot = { runAsNonRoot: true }, chosen = { runAsNonRoot: true, fsGroup: 1000 };
    assert.deepEqual(renderArgo(identities, { securityContext: nonRoot }), { "argocd-server": { ...nonRoot, fsGroup: 999 }, "argocd-application-controller": { ...nonRoot, fsGroup: 999 }, "argocd-repo-server": nonRoot });
    assert.deepEqual(renderArgo(identities, { securityContext: chosen }), { "argocd-server": chosen, "argocd-application-controller": chosen, "argocd-repo-server": chosen });
    for (const mounting of [0, 1]) assert.throws(() => renderArgo(identities, { mounting }), /must mount the projected identities/);
    const crossplane = (options: object) => new Crossplane(Testing.chart(), "xp", { argoCdProvider: false, kubernetesProvider: { rbac: false, pollInterval: "1m", installArgoCdClusterSyncSetup: false, installKarmadaCredentialSyncSetup: false, ...options } });
    const xp = crossplane(identities);
    const pod = xp.kubernetesProviderRuntimeConfig!.toJson().spec.deploymentTemplate.spec.template.spec, container = pod.containers[0];
    assert.deepEqual(container.args, ["--poll=1m"]); assert.equal(container.volumeMounts[0].mountPath, "/var/run/kubernetes-oidc/example");
    assert.deepEqual(pod.securityContext, { fsGroup: 2000 });
    assert.equal(xp.kubernetesProvider!.toJson().spec.runtimeConfigRef.name, "provider-kubernetes");
    assert.deepEqual(crossplane({}).kubernetesProviderRuntimeConfig!.toJson().spec.deploymentTemplate.spec.template.spec, { containers: [{ name: "package-runtime", args: ["--poll=1m"] }] });
  } finally { process.env.PATH = previous; rmSync(work, { recursive: true, force: true }); }
});

// Rendering the charts needs helm and the chart repositories: opt in with NEBULA_HELM_TESTS=1.
test("the Argo CD and autoscaler charts set the file group on token-mounting Pods only", { skip: process.env.NEBULA_HELM_TESTS !== "1" }, async () => {
  const { ArgoCd } = await import("../src/modules/k8s/argocd");
  const workloadIdentity = { cluster: "example" };
  const pods = (construct: (chart: Chart) => unknown) => {
    const chart = Testing.chart(); construct(chart);
    return Testing.synth(chart).filter(o => ["Deployment", "StatefulSet"].includes(o.kind)).map(o => ({ name: o.metadata.name, ...o.spec.template.spec }));
  };
  const argo = (values: Record<string, unknown> = {}, workloadIdentities = [workloadIdentity]) => pods(chart => new ArgoCd(chart, "argo", { workloadIdentities, values }));
  const autoscaler = (identity?: typeof workloadIdentity) => pods(chart => new ClusterAutoscaler(chart, "autoscaler", { clusterName: "example", workloadIdentity: identity }));
  // Exactly the named Pods mount the token, and only they carry a file group.
  const fileGroups = (rendered: ReturnType<typeof pods>, expected: Record<string, number>) => {
    for (const pod of rendered) {
      assert.equal(pod.volumes?.some((v: any) => v.name === "oidc-example") ?? false, pod.name in expected, pod.name);
      assert.equal(pod.securityContext?.fsGroup, expected[pod.name], pod.name);
    }
  };
  const renamed = { server: { name: "api" }, controller: { name: "controller" } };
  fileGroups(argo(), { "argocd-server": 999, "argocd-application-controller": 999 });
  fileGroups(argo(renamed), { "argocd-api": 999, "argocd-controller": 999 });
  fileGroups(argo({ fullnameOverride: "gitops" }), { "gitops-server": 999, "gitops-application-controller": 999 });
  fileGroups(autoscaler(workloadIdentity), { "cluster-autoscaler-example": 65532 });
  // A group chosen through the chart's own Pod security context stays in place.
  const chosen = argo({ ...renamed, global: { securityContext: { fsGroup: 1234 } } });
  for (const name of ["argocd-api", "argocd-controller"]) assert.equal(chosen.find(pod => pod.name === name)!.securityContext.fsGroup, 1234);
  assert.ok([...argo({}, []), ...autoscaler()].every(pod => pod.securityContext?.fsGroup === undefined));
});

test("control-plane composition rejects unsupported versions and mismatched hosting namespaces", () => {
  for (const config of [{ name: "example", authentication: { identity } }, { name: "example", namespace: "other", k8sVersion: "v1.35.0", authentication: { identity, namespace: "default" } }])
    assert.throws(() => new K0smotronCluster(Testing.chart(), "invalid", { ...config, provider, controlPlane: { authentication: config.authentication } }), /1.34|hosting namespace/);
});

test("private issuer IP endpoints verify IP SANs instead of DNS SANs", async () => {
  const { EnvoyJwtProxy } = await import("../src/modules/k8s/envoy/jwt-proxy");
  const proxy = new EnvoyJwtProxy({ issuers: { issuer: { url: "https://192.0.2.5", jwksUrl: "https://192.0.2.5/keys", audience: "kubernetes:example" } }, backend: { ...gateway.backend, caFile: "/ca/ca.crt" }, maxTokenLifetimeSeconds: 600 });
  const context = proxy.bootstrap.static_resources.clusters[1].transport_socket.typed_config.common_tls_context.validation_context;
  assert.deepEqual(context.match_typed_subject_alt_names, [{ san_type: "IP_ADDRESS", matcher: { exact: "192.0.2.5" } }]);
});
