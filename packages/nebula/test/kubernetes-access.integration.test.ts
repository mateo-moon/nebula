import assert from "node:assert/strict";
import test from "node:test";
import { isIP } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { Testing } from "cdk8s";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig as KubernetesAccessConfig } from "../src/modules/k8s/kubernetes-access/identity";
import { EnvoyJwtProxy } from "../src/modules/k8s/envoy/jwt-proxy";
import { KUBERNETES_OIDC_ENVOY_IMAGE as envoyImage } from "../src/modules/k8s/kubernetes-access/gateway";
import { K0sOidcAuthentication } from "../src/modules/infra/k0s/oidc-authentication";
import { ServiceAccountTokenLifetimePolicy } from "../src/modules/k8s/kubernetes-access/token-lifetime-policy";
const queryRefresherSubject = "system:serviceaccount:default:query-refresher";
const authenticationConfiguration = (c: KubernetesAccessConfig) => new KubernetesOidcIdentity(c).authenticationConfiguration();
const envoyConfiguration = (c: KubernetesAccessConfig) => new EnvoyJwtProxy({ issuers: { workforce: c.workforce, ...(c.workload ? { workload: c.workload } : {}) }, backend: { ...c.backend, caFile: "/etc/kubernetes-ca/ca.crt" }, maxTokenLifetimeSeconds: 600 }).bootstrap;

const exec = promisify(execFile);
const run = async (cmd: string, args: string[], timeout = 180_000) => (await exec(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const enabled = process.env.RUN_KUBERNETES_OIDC_INTEGRATION === "1";
const image = process.env.OIDC_TEST_KIND_IMAGE ?? "kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f";

test("real Kubernetes and Envoy enforce OIDC identity, audience and certificate rejection", { skip: !enabled, timeout: 420_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "kubernetes-oidc-integration-"));
  const name = `oidc-${process.pid}-${Date.now().toString(36)}`;
  const gatewayName = `${name}-gateway`;
  // Match the fixture owner so Linux bind mounts remain private (0700/0600)
  // while Envoy runs without root. Desktop Docker masks this permission issue.
  const fixtureUser = `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`;
  const issuerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...issuerKeys.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" };
  // Linux containers reach the host through its bridge address. Desktop Docker
  // supplies host.docker.internal. Both paths keep full TLS SAN verification.
  const issuerHost = process.platform === "linux"
    ? await run("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])
    : "host.docker.internal";
  const cert = join(work, "issuer.crt"), key = join(work, "issuer.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=host.docker.internal",
    "-addext", `subjectAltName=DNS:host.docker.internal${isIP(issuerHost) ? `,IP:${issuerHost}` : ""}`, "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", key, "-out", cert], { stdio: "ignore" });
  let issuerBase = "";
  const issuer = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const path = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (path.endsWith("/.well-known/openid-configuration")) {
      const id = path.replace("/.well-known/openid-configuration", "");
      res.end(JSON.stringify({
        issuer: `${issuerBase}${id}`, jwks_uri: `${issuerBase}${id}/keys`,
        id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"]
      }));
    } else if (path.endsWith("/keys")) res.end(JSON.stringify({ keys: [jwk] }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => issuer.listen(0, "0.0.0.0", resolve));
  issuerBase = `https://${issuerHost}:${(issuer.address() as any).port}`;
  const c: KubernetesAccessConfig = {
    cluster: "fixture", hostname: "api.fixture.example.test", namespace: "default", ingressClassName: "nginx", clusterIssuer: "fixture",
    workforce: { url: `${issuerBase}/people`, jwksUrl: `${issuerBase}/people/keys`, audience: "kubernetes:fixture", emailDomain: "example.test", certificateAuthority: readFileSync(cert, "utf8") },
    workload: {
      url: `${issuerBase}/workloads`, jwksUrl: `${issuerBase}/workloads/keys`, audience: "kubernetes:fixture",
      subjects: ["system:serviceaccount:argocd:controller"], certificateAuthority: readFileSync(cert, "utf8")
    },
    backend: { host: `${name}-control-plane`, port: 6443, serverName: "kubernetes", caSecret: { name: "fixture-ca", key: "tls.crt" } },
    systemSourceCidrs: ["192.0.2.5/32"],
  };
  const issue = (claims: Record<string, unknown> = {}, privateKey = issuerKeys.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: c.workforce.url, aud: "kubernetes:fixture", sub: "immutable-person-id", email: "employee@example.test",
      email_verified: true, iat: now, exp: now + 600, ...claims
    };
    const body = [Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url"), Buffer.from(JSON.stringify(payload)).toString("base64url")].join(".");
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  const reviewPath = "/apis/authentication.k8s.io/v1/selfsubjectreviews";
  const request = (url: string, options: Record<string, any> = {}): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", ...options, headers: { "Content-Type": "application/json", ...options.headers } }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.setTimeout(options.timeout ?? 8000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end(options.body ?? JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" }));
  });
  try {
    writeFileSync(join(work, "authentication.yaml"), stringify(authenticationConfiguration(c)));
    writeFileSync(join(work, "kind.yaml"), stringify({
      kind: "Cluster", apiVersion: "kind.x-k8s.io/v1alpha4",
      nodes: [{
        role: "control-plane", extraMounts: [{ hostPath: work, containerPath: "/etc/kubernetes/oidc" }],
        // kind uses v1beta3 through Kubernetes 1.35, and v1beta4 from 1.36.
        kubeadmConfigPatches: ["v1beta3", "v1beta4"].map(version => stringify({
          apiVersion: `kubeadm.k8s.io/${version}`, kind: "ClusterConfiguration", apiServer: {
            extraArgs: version === "v1beta3" ? { "authentication-config": "/etc/kubernetes/oidc/authentication.yaml", "anonymous-auth": "false" } :
              [{ name: "authentication-config", value: "/etc/kubernetes/oidc/authentication.yaml" }, { name: "anonymous-auth", value: "false" }],
            extraVolumes: [{ name: "oidc", hostPath: "/etc/kubernetes/oidc", mountPath: "/etc/kubernetes/oidc", readOnly: true, pathType: "Directory" }],
          }
        })),
      }],
    }));
    await run("kind", ["create", "cluster", "--name", name, "--image", image, "--config", join(work, "kind.yaml"), "--kubeconfig", join(work, "kubeconfig"), "--wait", "120s"]);
    const kube = parse(readFileSync(join(work, "kubeconfig"), "utf8"));
    const api = kube.clusters[0].cluster.server;
    const backendCa = Buffer.from(kube.clusters[0].cluster["certificate-authority-data"], "base64");
    const admin = { ca: backendCa, cert: Buffer.from(kube.users[0].user["client-certificate-data"], "base64"), key: Buffer.from(kube.users[0].user["client-key-data"], "base64") };
    writeFileSync(join(work, "backend-ca.crt"), backendCa);
    assert.equal((await request(`${api}${reviewPath}`, admin)).status, 201, "internal system certificate authentication remains available");
    const config = envoyConfiguration(c);
    const listener = config.static_resources.listeners[0];
    listener.address.socket_address.port_value = 8443;
    // Production ingress terminates TLS. This test terminates it directly in
    // Envoy to demonstrate that presenting a former admin certificate cannot
    // replace the required bearer token.
    listener.filter_chains[0].transport_socket = {
      name: "envoy.transport_sockets.tls", typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
        common_tls_context: { tls_certificates: [{ certificate_chain: { filename: "/fixture/issuer.crt" }, private_key: { filename: "/fixture/issuer.key" } }] },
      }
    };
    config.static_resources.clusters[0].transport_socket.typed_config.common_tls_context.validation_context.trusted_ca.filename = "/fixture/backend-ca.crt";
    writeFileSync(join(work, "envoy.yaml"), stringify(config));
    await run("docker", ["run", "--rm", "--user", fixtureUser, "-v", `${work}:/fixture:ro`, envoyImage, "--mode", "validate", "-c", "/fixture/envoy.yaml"]);
    await run("docker", ["run", "-d", "--user", fixtureUser, "--name", gatewayName, "--network", "kind", "-p", "127.0.0.1::8443", "-v", `${work}:/fixture:ro`, envoyImage,
      "-c", "/fixture/envoy.yaml", "--disable-hot-restart", "--log-level", "warn"]);
    const port = (await run("docker", ["port", gatewayName, "8443/tcp"])).split(":").at(-1);
    const publicUrl = `https://127.0.0.1:${port}${reviewPath}`;
    const publicTls = { ca: readFileSync(cert), servername: "host.docker.internal" };
    const throughGateway = (token?: string, extra: Record<string, any> = {}) => request(publicUrl, {
      ...publicTls, ...extra,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers }
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { const response = await throughGateway(issue()); if (response.status === 201) { ready = true; break; } }
      catch { /* Envoy listener/issuer/API may still be starting. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error(`OIDC did not become ready. Envoy diagnostics: ${await run("docker", ["logs", gatewayName])}`);
    const good = await throughGateway(issue({ groups: ["system:masters"] }), { headers: { "Impersonate-User": "system:admin", "X-Remote-User": "system:admin" } });
    assert.equal(good.status, 201);
    const who = JSON.parse(good.body).status.userInfo;
    assert.equal(who.username, "oidc:employee@example.test");
    assert.equal(who.uid, "immutable-person-id");
    assert.ok(who.groups.includes("oidc:employees")); assert.ok(!who.groups.includes("system:masters"));
    const stolen = await throughGateway(undefined, { cert: admin.cert, key: admin.key });
    assert.equal(stolen.status, 401, "a stolen admin certificate must not authenticate through the gateway");
    assert.equal((await throughGateway(undefined, { headers: { Authorization: "Basic Zm9vOmJhcg==" } })).status, 401);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { aud: "kubernetes:another-cluster" }, { iss: `${issuerBase}/untrusted` }, { exp: now - 1 },
      { email: "outsider@elsewhere.test" }, { email_verified: false }, { exp: now + 7200 },
    ]) assert.ok([401, 403].includes((await throughGateway(issue(claims))).status), `rejected claims ${JSON.stringify(claims)}`);
    const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.equal((await throughGateway(issue({}, foreign.privateKey))).status, 401, "wrong signature");
    const workloadClaims = { iss: c.workload!.url, sub: c.workload!.subjects[0], "kubernetes.io": { pod: { uid: "fixture-pod" } } };
    const workload = await throughGateway(issue(workloadClaims));
    if (workload.status !== 201) {
      const id = await run("docker", ["exec", `${name}-control-plane`, "crictl", "ps", "--name", "kube-apiserver", "-q"]);
      const diagnostics = await exec("docker", ["exec", `${name}-control-plane`, "crictl", "logs", "--tail=25", id]);
      const review = await request(`${api}/apis/authentication.k8s.io/v1/tokenreviews`, {
        ...admin, body: JSON.stringify({
          apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", spec: { token: issue(workloadClaims), audiences: ["kubernetes:fixture"] },
        })
      });
      assert.fail(`Workload federation returned ${workload.status}: ${workload.body}\n${JSON.stringify(JSON.parse(review.body).status)}\n${diagnostics.stdout}${diagnostics.stderr}`);
    }
    assert.equal(JSON.parse(workload.body).status.userInfo.username, `workload:${c.workload!.subjects[0]}`);
    assert.equal((await throughGateway(issue({ ...workloadClaims, sub: "system:serviceaccount:argocd:untrusted" }))).status, 401);
    assert.equal((await throughGateway(issue({ ...workloadClaims, "kubernetes.io": {} }))).status, 401, "unbound workload token");
    // The internal monitoring bridge cannot turn a stolen short-lived identity
    // into a permanent reader token. Verify admission with the real API.
    const create = async (path: string, object: object) => {
      const response = await request(`${api}${path}`, { ...admin, body: JSON.stringify(object) });
      assert.equal(response.status, 201, `creating ${path}: ${response.body}`);
    };
    await create("/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name: "monitoring" } });
    await create("/api/v1/namespaces/monitoring/serviceaccounts", { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "public-metrics-query-reader" } });
    for (const resource of [
      ...ServiceAccountTokenLifetimePolicy.manifests({ name: "reader-token-lifetime", requesterUsername: `workload:${queryRefresherSubject}` }),
      { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "oidc-query-token-refresher", namespace: "monitoring" }, rules: [{ apiGroups: [""], resources: ["serviceaccounts/token"], resourceNames: ["public-metrics-query-reader"], verbs: ["create"] }] },
      { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "oidc-query-token-refresher", namespace: "monitoring" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "oidc-query-token-refresher" }, subjects: [{ kind: "User", apiGroup: "rbac.authorization.k8s.io", name: `workload:${queryRefresherSubject}` }] },
    ] as any[]) {
      if (resource.metadata.name === "oidc-query-token-refresher") {
        const kind = resource.kind === "Role" ? "roles" : "rolebindings";
        await create(`/apis/rbac.authorization.k8s.io/v1/namespaces/monitoring/${kind}`, resource);
      } else if (resource.kind === "ValidatingAdmissionPolicy" || resource.kind === "ValidatingAdmissionPolicyBinding") {
        const kind = resource.kind === "ValidatingAdmissionPolicy" ? "validatingadmissionpolicies" : "validatingadmissionpolicybindings";
        await create(`/apis/admissionregistration.k8s.io/v1/${kind}`, resource);
      }
    }
    const readerToken = (expirationSeconds: number) => request(`${api}/api/v1/namespaces/monitoring/serviceaccounts/public-metrics-query-reader/token`, {
      ...admin, headers: { "Impersonate-User": `workload:${queryRefresherSubject}` }, body: JSON.stringify({
        apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec: { audiences: ["fixture-internal"], expirationSeconds },
      }),
    });
    let longToken = { status: 0, body: "" };
    for (let attempt = 0; attempt < 30; attempt++) {
      longToken = await readerToken(3600);
      if ([403, 422].includes(longToken.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok([403, 422].includes(longToken.status), "admission must reject a one-hour reader token");
    assert.ok(longToken.body.includes("Monitoring reader tokens must expire within ten minutes"), "the configured lifetime policy must cause the denial");
    assert.equal((await readerToken(600)).status, 201, "ten-minute reader rotation remains authorized");
    // Execute the production standalone firewall against the disposable node.
    // Envoy is allowed; a workstation reaching the raw host port is not.
    const gatewayIp = await run("docker", ["inspect", "-f", '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', gatewayName]);
    const nodeIp = await run("docker", ["inspect", "-f", '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', `${name}-control-plane`]);
    const gatewayIp6 = await run("docker", ["inspect", "-f", '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}', gatewayName]);
    const nodeIp6 = await run("docker", ["inspect", "-f", '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}', `${name}-control-plane`]);
    const nodes = await request(`${api}/api/v1/nodes`, { ...admin, method: "GET", body: "" });
    assert.equal(nodes.status, 200);
    const podCidrs = JSON.parse(nodes.body).items.flatMap((node: any) => node.spec.podCIDRs ?? [node.spec.podCIDR]).filter(Boolean);
    writeFileSync(join(work, "firewall.sh"), new K0sOidcAuthentication(Testing.chart(), "firewall", { identity: { ...c, systemSourceCidrs: [`${gatewayIp}/32`, `${nodeIp}/32`, ...podCidrs, ...[gatewayIp6, nodeIp6].filter(Boolean).map(ip => `${ip}/128`)] } }).systemApiFirewall());
    await run("docker", ["exec", `${name}-control-plane`, "sh", "/etc/kubernetes/oidc/firewall.sh"]);
    const isolated = await throughGateway(issue()).catch(error => { throw new Error(`OIDC endpoint failed after raw API isolation: ${error.message}`); });
    assert.equal(isolated.status, 201, "OIDC endpoint survives raw API isolation");
    await assert.rejects(request(`${api}${reviewPath}`, { ...admin, timeout: 2000 }), /timed out|ECONNRESET|socket hang up/,
      "the former raw certificate endpoint must be unreachable from an ordinary client");
  } finally {
    await run("docker", ["rm", "-f", gatewayName], 30_000).catch(() => { });
    await run("kind", ["delete", "cluster", "--name", name], 30_000).catch(() => { });
    await new Promise<void>(resolve => issuer.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
});
