import assert from "node:assert/strict";
import test from "node:test";
import { isIP } from "node:net";
import { createSocket } from "node:dgram";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse, stringify } from "yaml";
import { KubernetesOidcIdentity, type KubernetesOidcIdentityConfig as KubernetesAccessConfig } from "../src/modules/k8s/kubernetes-access/identity";
import { EnvoyJwtProxy } from "../src/modules/k8s/envoy/jwt-proxy";
import { KUBERNETES_OIDC_ENVOY_IMAGE as envoyImage, type KubernetesOidcGatewayConfig } from "../src/modules/k8s/kubernetes-access/gateway";
import { ServiceAccountTokenLifetimePolicy } from "../src/modules/k8s/kubernetes-access/token-lifetime-policy";
const rotatorSubject = "system:serviceaccount:tools:token-rotator";
const authenticationConfiguration = (c: KubernetesAccessConfig) => new KubernetesOidcIdentity(c).authenticationConfiguration();
const envoyConfiguration = (c: KubernetesOidcGatewayConfig) => new EnvoyJwtProxy({ issuers: { workforce: c.workforce, ...(c.workload ? { workload: c.workload } : {}) }, backend: { ...c.backend, caFile: "/etc/kubernetes-ca/ca.crt" }, maxTokenLifetimeSeconds: 600 }).bootstrap;

const exec = promisify(execFile);
const run = async (cmd: string, args: string[], timeout = 180_000) => (await exec(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const enabled = process.env.RUN_KUBERNETES_OIDC_INTEGRATION === "1";
const image = process.env.OIDC_TEST_KIND_IMAGE ?? "kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f";

test("public OIDC profiles merge without sharing another cluster's login audience", { skip: !enabled, timeout: 90_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "kubernetes-oidc-profiles-"));
  const clusters = ["alpha", "beta", "gamma"];
  try {
    const files = clusters.map(cluster => {
      const file = join(work, `${cluster}.yaml`);
      const profile = new KubernetesOidcIdentity({
        cluster, hostname: `api-${cluster}.example.test`,
        workforce: { url: "https://accounts.google.com", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs", audience: `${cluster}-desktop-client-id`, emailDomain: "example.test", maxTokenLifetimeSeconds: 3600,
          requiredClaims: { hd: "example.test", azp: `${cluster}-desktop-client-id` }, login: { grantType: "authcode", clientAuthentication: "client-secret", extraScopes: ["email"] } },
      }).userKubeconfig();
      writeFileSync(file, stringify(profile), { mode: 0o600 });
      return file;
    });
    // This reads only the explicit public fixture files. config view does
    // not invoke the exec plugin or contact any Kubernetes API.
    const merged = JSON.parse((await exec("kubectl", ["config", "view", "--merge", "-o", "json"], {
      env: { ...process.env, KUBECONFIG: files.join(delimiter) },
      // Allow bounded CI process startup time for this local-only merge.
      timeout: 60_000,
    })).stdout);
    assert.equal(merged.users.length, clusters.length, "each context must retain its own login configuration");
    for (const cluster of clusters) {
      const context = merged.contexts.find((c: any) => c.name === cluster).context;
      const user = merged.users.find((u: any) => u.name === context.user).user;
      assert.equal(context.cluster, cluster);
      assert.ok(user.exec.args.includes(`--oidc-client-id=${cluster}-desktop-client-id`));
      assert.ok(user.exec.args.includes("--token-cache-storage=keyring"));
      assert.equal(user.exec.command, "nebula-oidc-login");
      assert.ok(user.exec.args.includes(`--oidc-client-secret-file=~/.config/nebula/oidc/${cluster}.json`));
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

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
  const c: KubernetesOidcGatewayConfig = {
    cluster: "fixture", hostname: "api.fixture.example.test", namespace: "default", ingressClassName: "nginx", clusterIssuer: "fixture",
    workforce: {
      url: `${issuerBase}/google`, jwksUrl: `${issuerBase}/google/keys`, audience: "fixture-desktop-client-id",
      emailDomain: "example.test", groups: ["access:developers"], emailGroups: { "access:maintainers": ["maintainer@example.test"] },
      certificateAuthority: readFileSync(cert, "utf8"), maxTokenLifetimeSeconds: 3600,
      requiredClaims: { hd: "example.test", azp: "fixture-desktop-client-id" },
    },
    workload: {
      url: `${issuerBase}/workloads`, jwksUrl: `${issuerBase}/workloads/keys`, audience: "kubernetes:fixture",
      subjects: ["system:serviceaccount:argocd:controller"], certificateAuthority: readFileSync(cert, "utf8")
    },
    backend: { host: `${name}-control-plane`, port: 6443, serverName: "kubernetes", caSecret: { name: "fixture-ca", key: "tls.crt" } },
  };
  const issue = (claims: Record<string, unknown> = {}, privateKey = issuerKeys.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: c.workforce.url, aud: c.workforce.audience, azp: c.workforce.audience, hd: "example.test", sub: "immutable-person-id", email: "employee@example.test",
      email_verified: true, iat: now, exp: now + 3600, ...claims
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
    assert.ok(who.groups.includes("access:developers")); assert.ok(!who.groups.includes("system:masters"));
    assert.ok(!who.groups.includes("access:maintainers"));
    const maintainer = await throughGateway(issue({ email: "maintainer@example.test" }));
    assert.equal(maintainer.status, 201);
    assert.deepEqual(JSON.parse(maintainer.body).status.userInfo.groups.filter((group: string) => group.startsWith("access:")), ["access:developers", "access:maintainers"]);
    const certificateOnly = await throughGateway(undefined, { cert: admin.cert, key: admin.key });
    assert.equal(certificateOnly.status, 401, "a client certificate cannot substitute for a gateway JWT");
    assert.equal((await throughGateway(undefined, { headers: { Authorization: "Basic Zm9vOmJhcg==" } })).status, 401);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { aud: "kubernetes:another-cluster" }, { iss: `${issuerBase}/untrusted` }, { exp: now - 1 },
      { email: "outsider@elsewhere.test" }, { email_verified: false }, { exp: now + 7200 },
      { hd: "elsewhere.test" }, { hd: undefined }, { azp: "other-desktop-client-id" }, { azp: undefined },
      { iat: now - 3601, exp: now + 100 },
    ]) assert.ok([401, 403].includes((await throughGateway(issue(claims))).status), `rejected claims ${JSON.stringify(claims)}`);
    const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.equal((await throughGateway(issue({}, foreign.privateKey))).status, 401, "wrong signature");
    const workloadClaims = { iss: c.workload!.url, aud: c.workload!.audience, sub: c.workload!.subjects[0], exp: now + 600, "kubernetes.io": { pod: { uid: "fixture-pod" } } };
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
    assert.equal((await throughGateway(issue({ ...workloadClaims, exp: now + 3600 }))).status, 401, "one-hour human lifetimes must never extend workload trust");
    assert.equal((await throughGateway(issue({ ...workloadClaims, iat: now - 601, exp: now + 100 }))).status, 401, "the API rejects a long-issued workload token even when little lifetime remains");
    // A selected TokenRequest caller is bounded by admission even outside the
    // rotation job. Verify this against the real Kubernetes API.
    const create = async (path: string, object: object) => {
      const response = await request(`${api}${path}`, { ...admin, body: JSON.stringify(object) });
      assert.equal(response.status, 201, `creating ${path}: ${response.body}`);
    };
    await create("/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name: "apps" } });
    await create("/api/v1/namespaces/apps/serviceaccounts", { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "consumer" } });
    for (const resource of [
      ...ServiceAccountTokenLifetimePolicy.manifests({ name: "token-lifetime", requesterUsername: `workload:${rotatorSubject}` }),
      { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "token-rotator", namespace: "apps" }, rules: [{ apiGroups: [""], resources: ["serviceaccounts/token"], resourceNames: ["consumer"], verbs: ["create"] }] },
      { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "token-rotator", namespace: "apps" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "token-rotator" }, subjects: [{ kind: "User", apiGroup: "rbac.authorization.k8s.io", name: `workload:${rotatorSubject}` }] },
    ] as any[]) {
      if (resource.metadata.name === "token-rotator") {
        const kind = resource.kind === "Role" ? "roles" : "rolebindings";
        await create(`/apis/rbac.authorization.k8s.io/v1/namespaces/apps/${kind}`, resource);
      } else if (resource.kind === "ValidatingAdmissionPolicy" || resource.kind === "ValidatingAdmissionPolicyBinding") {
        const kind = resource.kind === "ValidatingAdmissionPolicy" ? "validatingadmissionpolicies" : "validatingadmissionpolicybindings";
        await create(`/apis/admissionregistration.k8s.io/v1/${kind}`, resource);
      }
    }
    const consumerToken = (expirationSeconds: number) => request(`${api}/api/v1/namespaces/apps/serviceaccounts/consumer/token`, {
      ...admin, headers: { "Impersonate-User": `workload:${rotatorSubject}` }, body: JSON.stringify({
        apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec: { audiences: ["fixture-internal"], expirationSeconds },
      }),
    });
    let longToken = { status: 0, body: "" };
    for (let attempt = 0; attempt < 30; attempt++) {
      longToken = await consumerToken(3600);
      if ([403, 422].includes(longToken.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok([403, 422].includes(longToken.status), "admission must reject requests exceeding the configured limit");
    assert.ok(longToken.body.includes("ServiceAccount tokens must expire within 600 seconds"), "the configured lifetime policy must cause the denial");
    assert.equal((await consumerToken(600)).status, 201, "requests within the configured limit remain authorized");
  } finally {
    await run("docker", ["rm", "-f", gatewayName], 30_000).catch(() => { });
    await run("kind", ["delete", "cluster", "--name", name], 30_000).catch(() => { });
    await new Promise<void>(resolve => issuer.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
});

test("JWKS fetch falls back from unreachable IPv6 to IPv4 with verified TLS", { skip: !enabled, timeout: 90_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "kubernetes-jwks-dns-"));
  const name = `jwks-dns-${process.pid}-${Date.now().toString(36)}`;
  const fixtureUser = `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`;
  const dockerHost = process.platform === "linux"
    ? await run("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])
    : (await run("docker", ["run", "--rm", "--entrypoint", "getent", envoyImage, "ahostsv4", "host.docker.internal"])).split(/\s/)[0]!;
  assert.equal(isIP(dockerHost), 4);
  const cert = join(work, "issuer.crt"), key = join(work, "issuer.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fixture",
    "-addext", "subjectAltName=DNS:*.example.test", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const body = [{ alg: "RS256", kid: "fixture" }, { iss: "https://issuer.example.test", aud: "fixture-client", sub: "fixture", iat: now, exp: now + 600 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  const token = `${body}.${sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url")}`;
  const jwksSni: string[] = [], backendSni: string[] = [];
  let forwardedIdentity = false;
  const issuer = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/keys") {
      jwksSni.push((req.socket as import("node:tls").TLSSocket).servername || "");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      backendSni.push((req.socket as import("node:tls").TLSSocket).servername || "");
      forwardedIdentity = req.headers.authorization === `Bearer ${token}`;
      res.end(JSON.stringify({ accepted: true }));
    }
  });
  const dns = createSocket("udp4");
  const queries = { A: 0, AAAA: 0 };
  // Answer both families, with a documentation-only IPv6 address that cannot
  // reach this IPv4 fixture. No public DNS or identity provider is contacted.
  dns.on("message", (query, peer) => {
    let end = 12;
    const labels: string[] = [];
    while (end < query.length && query[end]) {
      const size = query[end++]!;
      if (size > 63 || end + size > query.length) return;
      labels.push(query.subarray(end, end + size).toString()); end += size;
    }
    end++;
    if (end + 4 > query.length) return;
    const type = query.readUInt16BE(end), questionEnd = end + 4;
    const matches = labels.join(".").toLowerCase() === "jwks.example.test";
    if (matches && type === 1) queries.A++;
    if (matches && type === 28) queries.AAAA++;
    const address = matches ? (type === 1 ? Buffer.from(dockerHost.split(".").map(Number)) :
      type === 28 ? Buffer.from("20010db800000000000000000000000001", "hex") : undefined) : undefined;
    const header = Buffer.alloc(12); query.copy(header, 0, 0, 2);
    header.writeUInt16BE(matches ? 0x8180 : 0x8183, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(address ? 1 : 0, 6);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4);
    record.writeUInt32BE(1, 6); record.writeUInt16BE(address?.length ?? 0, 10);
    dns.send(Buffer.concat([header, query.subarray(12, questionEnd), ...(address ? [record, address] : [])]), peer.port, peer.address);
  });
  await new Promise<void>(resolve => issuer.listen(0, "0.0.0.0", resolve));
  await new Promise<void>(resolve => dns.bind(0, "0.0.0.0", resolve));
  try {
    const config = new EnvoyJwtProxy({
      issuers: { workforce: { url: "https://issuer.example.test", jwksUrl: `https://jwks.example.test:${(issuer.address() as any).port}/keys`,
        audience: "fixture-client", certificateAuthority: readFileSync(cert, "utf8") } },
      backend: { host: dockerHost, port: (issuer.address() as any).port, serverName: "api.example.test", caFile: "/fixture/issuer.crt" },
      maxTokenLifetimeSeconds: 600,
    }).bootstrap;
    const jwks = config.static_resources.clusters[1];
    jwks.dns_resolvers = [{ socket_address: { address: dockerHost, port_value: dns.address().port } }];
    assert.equal(config.static_resources.clusters[0].type, "STRICT_DNS", "Kubernetes backend discovery stays unchanged");
    for (const mode of ["ipv6-preferred", "dual-stack"]) {
      const variant = structuredClone(config);
      if (mode === "ipv6-preferred") {
        variant.static_resources.clusters[1].type = "STRICT_DNS";
        delete variant.static_resources.clusters[1].dns_lookup_family;
      }
      writeFileSync(join(work, `${mode}.yaml`), stringify(variant));
      const container = `${name}-${mode}`;
      try {
        await run("docker", ["run", "-d", "--name", container, "--user", fixtureUser, "--entrypoint", "/usr/local/bin/envoy",
          "-p", "127.0.0.1::8080", "-v", `${work}:/fixture:ro`, envoyImage, "-c", `/fixture/${mode}.yaml`, "--disable-hot-restart", "--concurrency", "1", "--log-level", "warn"]);
        const port = (await run("docker", ["port", container, "8080/tcp"])).split(":").at(-1);
        let response: { status: number; body: string } | undefined;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const result = await fetch(`http://127.0.0.1:${port}/probe`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(7000) });
            response = { status: result.status, body: await result.text() };
            if (mode === "ipv6-preferred" ? queries.AAAA > 0 : response.status === 200) break;
          } catch { /* Wait for the disposable Envoy listener. */ }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (mode === "ipv6-preferred") {
          assert.equal(response?.status, 401);
          assert.equal(response?.body, "Jwks remote fetch is failed");
          assert.equal(jwksSni.length, 0);
        } else {
          assert.equal(response?.status, 200, `dual-stack JWKS lookup: ${response?.body}`);
          assert.ok(queries.A > 0 && queries.AAAA > 0, "both address families were resolved");
          assert.ok(jwksSni.includes("jwks.example.test"), "JWKS TLS verifies its own hostname, separately from the issuer");
          assert.ok(backendSni.includes("api.example.test"));
          assert.ok(forwardedIdentity, "the backend receives the original signed identity");
        }
      } finally { await run("docker", ["rm", "-f", container], 30_000).catch(() => { }); }
    }
  } finally {
    await new Promise<void>(resolve => dns.close(() => resolve()));
    await new Promise<void>(resolve => issuer.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
  }
});
