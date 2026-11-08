import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Testing } from "cdk8s";
import { K0SmotronControlPlaneV1Beta2SpecStorageType } from "../imports/controlplane.cluster.x-k8s.io";
import { parse } from "yaml";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig } from "../src/modules/k8s/kubernetes-access/identity";
import { KubernetesWorkloadIdentity, KubernetesWorkloadKubeconfig, PROJECTED_TOKEN_EXEC_CREDENTIAL_COMMAND } from "../src/modules/k8s/kubernetes-access/workload-identity";
import { KubernetesOidcGateway } from "../src/modules/k8s/kubernetes-access/gateway";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { K0sCluster, type K0sInfraProvider } from "../src/modules/infra/k0s/cluster";
import { AwsK0sCluster } from "../src/modules/infra/aws/k0s-cluster";
import { ArgoCdOidcCluster } from "../src/modules/k8s/argocd/oidc-cluster";
import { clusterAutoscalerValues } from "../src/modules/k8s/cluster-autoscaler";
import { ServiceAccountTokenRotation } from "../src/modules/k8s/kubernetes-access/token-rotation";

const identity: KubernetesOidcIdentityConfig = {
  cluster: "example", hostname: "api.example.test", namespace: "default", ingressClassName: "nginx", clusterIssuer: "public-tls",
  workforce: { url: "https://login.example.test", jwksUrl: "https://login.example.test/keys", audience: "kubernetes:example", emailDomain: "example.test" },
  workload: { url: "https://workload.example.test", jwksUrl: "https://workload.example.test/keys", audience: "kubernetes:example", subjects: ["system:serviceaccount:gitops:controller"] },
  backend: { host: "api.internal.example.test", port: 30443, serverName: "api.internal.example.test", caSecret: { name: "example-ca", key: "tls.crt" } }, systemSourceCidrs: [],
};
const provider: K0sInfraProvider<object> = {
  infraClusterApiGroup: "infrastructure.cluster.x-k8s.io", infraClusterKind: "RemoteCluster", emitInfraCluster: () => { },
  emitMachineTemplate: (_s, _i, c) => ({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta1", kind: "RemoteMachineTemplate", name: c.baseName })
};
const isolation = { controlPlaneLabels: { target: "example" }, gatewayLabels: { gateway: "example" }, platformNamespaces: ["capi-system"] };

test("identity requires exact audiences, verified workforce and bounded system sources", () => {
  const i = new KubernetesOidcIdentity(identity);
  assert.throws(() => i.validate(true), /systemSourceCidrs/);
  for (const cidr of ["0.0.0.0/0", "::/0", "192.0.2.0/8", "192.0.2.1/999", "not-an-ip/32"])
    assert.throws(() => new KubernetesOidcIdentity({ ...identity, systemSourceCidrs: [cidr] }), /Unsafe or invalid/);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...identity.workforce, url: "http://login.example.test" } }), /HTTPS/);
  for (const audience of ["", "*", "two audiences"])
    assert.throws(() => new KubernetesOidcIdentity({ ...identity, workforce: { ...identity.workforce, audience } }), /exact.*audience/);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workload: { ...identity.workload!, audience: "shared" } }), /target cluster/);
  assert.throws(() => new KubernetesOidcIdentity({ ...identity, workload: { ...identity.workload!, subjects: ["system:serviceaccount:*:*"] } }), /exact ServiceAccount/);
  const auth: any = i.authenticationConfiguration();
  assert.equal(auth.anonymous, undefined); assert.deepEqual(auth.jwt[0].issuer.audiences, ["kubernetes:example"]);
  assert.equal(auth.jwt[0].claimMappings.groups.expression, '["oidc:employees"]'); assert.equal(auth.jwt[1].claimMappings.groups, undefined);
  assert.ok(auth.jwt[1].claimValidationRules.some((r: any) => r.expression.includes("pod.uid")));
  for (const config of [i.userKubeconfig(), i.workloadKubeconfig()]) assert.ok(!/client-certificate|client-key|insecure-skip-tls-verify|client-secret/.test(JSON.stringify(config)));
  const server: any = i.userKubeconfig({ command: "/usr/local/bin/oidc-login", grantType: "device-code", tokenCacheStorage: "disk", tokenCacheDirectory: "/run/login" });
  assert.equal(server.users[0].user.exec.command, "/usr/local/bin/oidc-login"); assert.ok(server.users[0].user.exec.args.includes("--grant-type=device-code"));
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
  assert.throws(() => new KubernetesOidcIdentity({ ...config, workload: { ...config.workload!, maxTokenLifetimeSeconds: 3600 } }), /600-second/);
  for (const maxTokenLifetimeSeconds of [0, -1, 3601, 1.5, Infinity])
    assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, maxTokenLifetimeSeconds } }), /lifetime/);
  const invalidParams: Record<string, string>[] = [{ code_challenge_method: "plain" }, { client_secret: "forbidden" }, { prompt: "consent,scope=anything" }];
  for (const authRequestExtraParams of invalidParams)
    assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, login: { authRequestExtraParams } } }), /protocol security/);
  assert.throws(() => new KubernetesOidcIdentity({ ...config, workforce: { ...config.workforce, requiredClaims: { "hd) || true": "example.test" } } }), /exact claim/);
  const chart = Testing.chart(); new KubernetesOidcGateway(chart, "google", config);
  const envoy = parse(Testing.synth(chart).find(o => o.kind === "ConfigMap")!.data["envoy.yaml"]);
  const hcm = envoy.static_resources.listeners[0].filter_chains[0].filters[0].typed_config;
  assert.equal(hcm.http_filters[0].typed_config.providers.workforce.max_lifetime, "3600s");
  assert.equal(hcm.http_filters[0].typed_config.providers.workload.max_lifetime, "600s");
  assert.equal(hcm.route_config.virtual_hosts[0].routes[0].route.max_stream_duration.max_stream_duration, "600s");
});

test("gateway verifies every bearer and backend TLS and mounts public CA only", () => {
  const chart = Testing.chart(); new KubernetesOidcGateway(chart, "gateway", { ...identity, podLabels: { migrated: "preserve-selector" } });
  const objects = Testing.synth(chart), deployment = objects.find(o => o.kind === "Deployment")!, pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false); assert.deepEqual(deployment.spec.selector.matchLabels, { migrated: "preserve-selector" });
  assert.deepEqual(pod.volumes.find((v: any) => v.name === "backend-ca").secret.items, [{ key: "tls.crt", path: "ca.crt" }]);
  const config = parse(objects.find(o => o.kind === "ConfigMap")!.data["envoy.yaml"]), hcm = config.static_resources.listeners[0].filter_chains[0].filters[0].typed_config;
  const jwt = hcm.http_filters[0].typed_config; assert.deepEqual(jwt.rules[0].match, { prefix: "/" }); assert.ok(!JSON.stringify(jwt.rules).includes("allow_missing"));
  for (const p of Object.values(jwt.providers) as any[]) { assert.equal(p.forward, true); assert.equal(p.max_lifetime, "600s"); assert.equal(p.require_expiration, true); }
  assert.ok(hcm.http_filters[1].typed_config.default_source_code.inline_string.includes('^impersonate%-'));
  assert.ok(!JSON.stringify(config).includes("tls_certificates")); assert.ok(!JSON.stringify(hcm.access_log).includes("PATH"));
  assert.ok(!objects.some(o => ["ServiceAccount", "ClusterRoleBinding"].includes(o.kind)));
});

test("native hosted auth preserves workers, storage and repeated service-account issuers", () => {
  const render = (authentication?: any) => {
    const chart = Testing.chart();
    new K0smotronCluster(chart, "cluster", {
      name: "example", k8sVersion: "v1.35.0", provider, workerPools: { workers: { machine: {}, replicas: 2 } }, controlPlane: {
        authentication, storage: { type: K0SmotronControlPlaneV1Beta2SpecStorageType.ETCD, etcd: { image: "quay.io/k0sproject/etcd:v3.5.13", autoDeletePvCs: false } },
        apiExtraArgs: { "oidc-issuer-url": "https://old.example.test", "service-account-issuer": "https://workload.example.test" },
        apiRawArgs: ["--oidc-groups-claim=aud", "--anonymous-auth", "true", "--service-account-issuer=https://old-workload.example.test"], serviceAnnotations: { retained: "true" },
      }
    }); return Testing.synth(chart);
  };
  const before = render(), prepared = render({ identity }), cp = prepared.find(o => o.kind === "K0smotronControlPlane")!;
  const workers = (objects: any[]) => objects.filter(o => ["K0sWorkerConfigTemplate", "MachineDeployment"].includes(o.kind));
  assert.deepEqual(workers(prepared), workers(before)); assert.equal(cp.spec.storage.etcd.image, "quay.io/k0sproject/etcd:v3.5.13"); assert.equal(cp.spec.storage.etcd.autoDeletePVCs, false);
  assert.equal(cp.spec.k0sConfig.spec.api.extraArgs["anonymous-auth"], "false"); assert.equal(cp.spec.k0sConfig.spec.api.extraArgs["oidc-issuer-url"], undefined);
  assert.deepEqual(cp.spec.k0sConfig.spec.api.rawArgs, ["--service-account-issuer=https://old-workload.example.test"]); assert.ok(!prepared.some(o => o.kind === "NetworkPolicy"));
  const isolated = render({ identity: { ...identity, systemSourceCidrs: ["192.0.2.5/32", "2001:db8::5/128"] }, isolation });
  assert.ok(isolated.some(o => o.kind === "NetworkPolicy")); assert.deepEqual(workers(isolated), workers(before));
});

test("standalone cloud and bare-metal composition share files and retain service-account issuer", () => {
  for (const type of ["generic", "aws"]) {
    const chart = Testing.chart();
    const authentication = { identity: { ...identity, systemSourceCidrs: ["192.0.2.0/24", "2001:db8::/64"] }, isolation };
    if (type === "generic") new K0sCluster(chart, "standalone", { name: "example", k8sVersion: "v1.35.0", provider, controlPlane: { machine: {}, authentication }, oidcIssuer: { issuerUrl: "https://native.example.test" } });
    else new AwsK0sCluster(chart, "standalone", { name: "example", k8sVersion: "v1.35.0", region: "eu-central-1", controlPlane: { authentication }, oidcIssuer: { issuerUrl: "https://native.example.test" } });
    const cp = Testing.synth(chart).find(o => o.kind === "K0sControlPlane")!;
    assert.equal(cp.spec.k0sConfigSpec.k0s.spec.api.extraArgs["service-account-issuer"], "https://native.example.test");
    assert.ok(cp.spec.k0sConfigSpec.files.some((f: any) => f.path.endsWith("authentication.yaml"))); assert.ok(cp.spec.k0sConfigSpec.preK0sCommands.includes("systemctl enable --now kubernetes-system-api.service"));
    const firewall = cp.spec.k0sConfigSpec.files.find((f: any) => f.path.endsWith("restrict-system-api.sh")).content;
    assert.ok(firewall.includes("ip6 saddr 2001:db8::/64")); assert.ok(!firewall.includes("flush ruleset")); assert.equal(spawnSync("sh", ["-n"], { input: firewall }).status, 0);
  }
});

test("Argo and autoscaler share rotating file identity; retirement is explicit", () => {
  const chart = Testing.chart(), token = new KubernetesWorkloadIdentity({ cluster: "example" });
  new ArgoCdOidcCluster(chart, "argo", { name: "example", server: "https://api.example.test", identity: { cluster: "example" } });
  new KubernetesWorkloadKubeconfig(chart, "client", { name: "example-oidc", namespace: "default", server: "https://api.example.test", identity: { cluster: "example" } });
  const objects = Testing.synth(chart); assert.ok(objects.every(o => o.kind === "Secret")); assert.ok(!/client-certificate|client-key|bearerToken|certData|keyData/.test(JSON.stringify(objects)));
  assert.equal(parse(objects.find(o => o.metadata.name === "example-oidc")!.stringData.value).users[0].user.tokenFile, token.tokenPath);
  const values: any = clusterAutoscalerValues({ clusterName: "example", workloadIdentity: { cluster: "example" }, workloadKubeconfigSecret: "example-oidc" });
  assert.equal(values.clusterAPIKubeconfigSecret, "example-oidc"); assert.deepEqual(values.extraVolumes, [token.projection.volume]);
  assert.throws(() => KubernetesWorkloadIdentity.podSpec([{ cluster: "example" }, { cluster: "example" }]), /Duplicate/);
  new ArgoCdOidcCluster(chart, "retire", { name: "other", server: "https://api.other.test", identity: { cluster: "other" }, retireLegacyCertificateSync: { syncName: "other-argocd-sync", secretName: "other" } });
  assert.ok(Testing.synth(chart).find(o => o.kind === "Job")!.spec.template.spec.containers[0].args[0].includes('if [ -n "$legacy" ]'));
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
  const chart = Testing.chart(); new ServiceAccountTokenRotation(chart, "rotation", { name: "reader-rotation", namespace: "default", targetNamespace: "monitoring", targets: [{ serviceAccount: "reader", secret: "reader-rotating" }], identity: { cluster: "example" }, kubeconfigSecret: "example-oidc", caSecret: { name: "example-ca", key: "tls.crt" } });
  const pod = Testing.synth(chart).find(o => o.kind === "CronJob")!.spec.jobTemplate.spec.template.spec;
  assert.equal(pod.volumes.find((v: any) => v.name === "work").emptyDir.medium, "Memory"); assert.equal(pod.automountServiceAccountToken, false);
  assert.ok(pod.containers[0].args[0].includes("reader:reader-rotating")); assert.equal(spawnSync("sh", ["-n"], { input: pod.containers[0].args[0] }).status, 0);
});

test("Argo and Crossplane consume shared projections through their own configuration", async () => {
  const { ArgoCd } = await import("../src/modules/k8s/argocd");
  const { Crossplane } = await import("../src/modules/k8s/crossplane");
  const { readFileSync } = await import("node:fs");
  const work = mkdtempSync(join(tmpdir(), "nebula-oidc-helm-")), values = join(work, "values.yaml"), previous = process.env.PATH;
  writeFileSync(join(work, "helm"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('-f'))fs.copyFileSync(args[args.indexOf('-f')+1],${JSON.stringify(values)});\n`, { mode: 0o755 });
  process.env.PATH = `${work}:${previous}`;
  try {
    const chart = Testing.chart();
    new ArgoCd(chart, "argo", { workloadIdentities: [{ cluster: "example" }], values: { controller: { volumes: [{ name: "existing", emptyDir: {} }] } } });
    const argoValues = parse(readFileSync(values, "utf8"));
    for (const component of ["controller", "server"]) assert.ok(argoValues[component].volumes.some((v: any) => v.name === "oidc-example"));
    assert.ok(argoValues.controller.volumes.some((v: any) => v.name === "existing"));
    const xp = new Crossplane(chart, "xp", { argoCdProvider: false, kubernetesProvider: { rbac: false, pollInterval: "1m", workloadIdentities: [{ cluster: "example" }], installArgoCdClusterSyncSetup: false, installKarmadaCredentialSyncSetup: false } });
    const runtime = xp.kubernetesProviderRuntimeConfig!.toJson(), container = runtime.spec.deploymentTemplate.spec.template.spec.containers[0];
    assert.deepEqual(container.args, ["--poll=1m"]); assert.equal(container.volumeMounts[0].mountPath, "/var/run/kubernetes-oidc/example");
    assert.equal(xp.kubernetesProvider!.toJson().spec.runtimeConfigRef.name, "provider-kubernetes");
  } finally { process.env.PATH = previous; rmSync(work, { recursive: true, force: true }); }
});

test("control-plane composition rejects unsupported versions and mismatched hosting namespaces", () => {
  for (const config of [{ name: "example", authentication: { identity } }, { name: "example", namespace: "other", k8sVersion: "v1.35.0", authentication: { identity } }])
    assert.throws(() => new K0smotronCluster(Testing.chart(), "invalid", { ...config, provider, controlPlane: { authentication: config.authentication } }), /1.34|hosting namespace/);
});

test("private issuer IP endpoints verify IP SANs instead of DNS SANs", async () => {
  const { EnvoyJwtProxy } = await import("../src/modules/k8s/envoy/jwt-proxy");
  const proxy = new EnvoyJwtProxy({ issuers: { issuer: { url: "https://192.0.2.5", jwksUrl: "https://192.0.2.5/keys", audience: "kubernetes:example" } }, backend: { ...identity.backend, caFile: "/ca/ca.crt" }, maxTokenLifetimeSeconds: 600 });
  const context = proxy.bootstrap.static_resources.clusters[1].transport_socket.typed_config.common_tls_context.validation_context;
  assert.deepEqual(context.match_typed_subject_alt_names, [{ san_type: "IP_ADDRESS", matcher: { exact: "192.0.2.5" } }]);
});
