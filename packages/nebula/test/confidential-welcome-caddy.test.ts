import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ConfidentialWelcome } from "../src/modules/k8s/confidential-workloads/welcome";
import { fixtureIdentity } from "./support/confidential-welcome-tls.ts";

// Optional integration: WELCOME_CADDY_INTEGRATION=1 pnpm exec tsx --test test/confidential-welcome-caddy.test.ts
// Both product images share a network namespace with no external network. Only
// a fresh in-memory test identity is loaded; production ACME is never contacted.
test("pinned Caddy serves the actual loopback welcome assets to a verified no-SNI IP client", {
  skip: process.env.WELCOME_CADDY_INTEGRATION !== "1", timeout: 60_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-welcome-caddy-"));
  chmodSync(directory, 0o755);
  const chart = new Chart(new App(), "welcome");
  new ConfidentialWelcome(chart, "guide", { name: "welcome", namespace: "qualified", ipAddress: "127.0.0.1",
    acmeEmail: "admin@example.org", acmeClaimName: "welcome-acme", portalUrl: "https://192.0.2.10:9443/",
    portalService: { name: "frontend", namespace: "qualified" },
    publicOhttpRoutes: [{ port: 8440, upstream: "http://confidential-operator-access.qualified.svc:8083" },
      { port: 8441, upstream: "http://preparation.qualified.svc:8445" }, { port: 8442, upstream: "http://owner.qualified.svc:8445" }] });
  const resources = Testing.synth(chart), data = resources.find(resource => resource.kind === "ConfigMap").data;
  const containers = resources.find(resource => resource.kind === "Deployment").spec.template.spec.containers;
  const nodeImage = containers.find((container: any) => container.name === "welcome").image;
  const caddyImage = containers.find((container: any) => container.name === "https").image;
  const id = randomUUID(), nodeName = `welcome-node-test-${id}`, caddyName = `welcome-caddy-test-${id}`;
  const mount = ["--mount", `type=bind,src=${directory},dst=/app,readonly`];
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
  try {
    for (const [name, content] of Object.entries(data)) writeFileSync(join(directory, name), String(content));
    const adapted = JSON.parse(docker(["run", "--rm", "--network", "none", "--read-only", "--user", "10001:10001",
      ...mount, caddyImage, "caddy", "adapt", "--config", "/app/Caddyfile", "--adapter", "caddyfile"]));
    const policies = adapted.apps.tls.automation.policies;
    assert.equal(policies.length, 1);
    assert.deepEqual(policies[0].subjects, ["127.0.0.1"]);
    assert.equal(policies[0].issuers.length, 1);
    assert.equal(policies[0].issuers[0].module, "acme");
    assert.equal(policies[0].issuers[0].ca, "https://acme-v02.api.letsencrypt.org/directory");
    assert.equal(policies[0].issuers[0].profile, "shortlived");
    assert.equal(policies[0].issuers[0].challenges.http.alternate_port, 8080);
    assert.equal(policies[0].issuers[0].challenges["tls-alpn"].disabled, true);
    const fixture = fixtureIdentity();
    // Substitute only the TLS source for this offline test. Keep the adapted
    // HTTP routing, default_sni, headers and product assets exactly as rendered.
    adapted.apps.tls = { certificates: { load_pem: [{ certificate: fixture.cert, key: fixture.key.toString() }] } };
    for (const server of Object.values(adapted.apps.http.servers) as any[]) {
      server.automatic_https = { ...server.automatic_https, disable_certificates: true };
    }
    const testUpstreams = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.dial === "string" && value.dial.includes(".svc:")) {
        value.dial = value.dial.endsWith(":8083") ? "127.0.0.1:18490" : "127.0.0.1:18445";
      }
      for (const child of Object.values(value)) testUpstreams(child);
    };
    testUpstreams(adapted.apps.http.servers);
    writeFileSync(join(directory, "offline-caddy.json"), JSON.stringify(adapted));
    writeFileSync(join(directory, "test-ca.pem"), fixture.cert);
    const bootstrap = `import {createServer} from "node:http";import {createServer as tlsServer} from "node:https";import {spawn} from "node:child_process";import {readFileSync} from "node:fs";import {X509Certificate} from "node:crypto";
const credential=JSON.parse(readFileSync("/app/offline-caddy.json","utf8")).apps.tls.certificates.load_pem[0];
tlsServer({...credential,minVersion:"TLSv1.3",cert:credential.certificate},(req,res)=>{if(req.url!=="/nebula/v1/tls"||req.headers.authorization||req.headers.cookie||req.headers["x-tng-ohttp-api"]){res.writeHead(403).end();return;}res.setHeader("Content-Type","application/json");res.end(JSON.stringify({version:1,certificateDer:new X509Certificate(credential.certificate).raw.toString("base64")}));}).listen(10443,"127.0.0.1");
for(const port of [18445,18490])createServer((req,res)=>{const chunks=[];req.on("data",chunk=>chunks.push(chunk));req.on("end",()=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify({method:req.method,path:req.url,authorizationPreserved:req.headers.authorization==="Bearer synthetic-test-proof",cookiePreserved:req.headers.cookie==="synthetic=only",ohttpHeaderPreserved:req.headers["x-tng-ohttp-api"]==="/tng/key-config",body:Buffer.concat(chunks).toString()}));});}).listen(port,"127.0.0.1");
const child=spawn(process.execPath,["--disable-sigusr1","/app/server.mts"],{stdio:"inherit"});child.once("exit",code=>process.exit(code??1));process.once("SIGTERM",()=>child.kill("SIGTERM"));`;
    docker(["run", "--detach", "--name", nodeName, "--network", "none", "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--add-host", "frontend.qualified.svc:127.0.0.1",
      ...mount, nodeImage, "node", "--input-type=module", "-e", bootstrap]);
    docker(["run", "--detach", "--name", caddyName, "--network", `container:${nodeName}`, "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/data:rw,uid=10001,gid=10001",
      "--tmpfs", "/tmp:rw,uid=10001,gid=10001", ...mount, caddyImage, "caddy", "run", "--config", "/app/offline-caddy.json"]);
    const client = `import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {request} from "node:https";
import {get} from "node:http";
import {createHash} from "node:crypto";
const ca=readFileSync("/app/test-ca.pem");
const call=(path,method="GET",port=8443,payload=undefined)=>new Promise((resolve,reject)=>{
  const req=request({host:"127.0.0.1",port,servername:"",ca,rejectUnauthorized:true,minVersion:"TLSv1.3",path,method,agent:false,headers:{Authorization:"Bearer synthetic-test-proof",Cookie:"synthetic=only","x-tng-ohttp-api":"/tng/key-config"}},response=>{
    const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString(),peer:createHash("sha256").update(response.socket.getPeerCertificate().raw).digest("hex")}));
  });req.setTimeout(2000,()=>req.destroy(new Error("timeout")));req.once("error",reject);req.end(payload);
});
let ready=false;const deadline=Date.now()+8000;
while(Date.now()<deadline){try{if((await call("/healthz")).status===200){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
assert.equal(ready,true,"No-SNI TLS listener becomes ready");
const results={};for(const path of ["/","/welcome.js","/style.css","/config.json","/healthz"]){const response=await call(path);assert.equal(response.status,200,path);assert.equal(response.headers["cache-control"],"no-store");assert.equal(response.headers["referrer-policy"],"no-referrer");results[path]=response.status;}
assert.equal((await call("/server.mts")).status,404);assert.equal((await call("/api/certificate?url=https://example.org/")).status,404);assert.equal((await call("/","POST")).status,405);
const first=await call("/");assert.match(first.body,/Meet your confidential portal/);assert.equal(first.peer,${JSON.stringify(createHash("sha256").update(fixture.der).digest("hex"))});
const publicConfig=JSON.parse((await call("/config.json")).body);assert.deepEqual(Object.keys(publicConfig),["portalUrl"]);assert.equal(publicConfig.portalUrl,"https://192.0.2.10:9443/");
const reported=await call("/api/certificate");assert.equal(reported.status,200,"Private Service origin is used instead of unreachable external portal");const material=JSON.parse(reported.body);assert.equal(material.verification,"unverified");assert.equal(material.certificateSha256,first.peer);
for(const port of [8440,8441,8442]){const metadata=port===8440;const response=await call(metadata?"/api/v1/public":"/",metadata?"GET":"POST",port,metadata?undefined:"opaque-ohttp-fixture");assert.equal(response.status,200);assert.equal(response.peer,first.peer,"Every public port uses the same IP certificate");const result=JSON.parse(response.body);assert.equal(result.authorizationPreserved,true);assert.equal(result.cookiePreserved,true);assert.equal(result.ohttpHeaderPreserved,true);assert.equal(result.body,metadata?"":"opaque-ohttp-fixture");}
const redirect=await new Promise((resolve,reject)=>{get("http://127.0.0.1:8080/",response=>{response.resume();resolve({status:response.statusCode,location:response.headers.location});}).once("error",reject);});assert.equal(redirect.status,308);assert.equal(redirect.location,"https://127.0.0.1/");
const listener=readFileSync("/proc/net/tcp","utf8").split("\\n").find(line=>line.split(/\\s+/)[2]==="0100007F:1F91");assert.ok(listener,"Node8081 binds loopback only");
console.log(JSON.stringify({uid:process.getuid(),noSni:true,ipSanAndLocalChainVerified:true,assets:results,negativeRoutesRejected:true,nodeLoopbackOnly:true,httpRedirectUsesPublic443:true,publicRoutesPreserveCiphertextAndProofHeaders:true,oneIpCertificateAcrossAllPorts:true,externalNetwork:false,productionAcmeContacted:false}));`;
    const receipt = JSON.parse(docker(["run", "--rm", "--network", `container:${nodeName}`, "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...mount, nodeImage, "node", "--input-type=module", "-e", client]));
    assert.equal(receipt.noSni, true);
    assert.equal(receipt.nodeLoopbackOnly, true);
    assert.equal(receipt.productionAcmeContacted, false);
    assert.equal(receipt.publicRoutesPreserveCiphertextAndProofHeaders, true);
    assert.equal(receipt.uid, 10001);
  } finally {
    for (const name of [caddyName, nodeName]) {
      try { docker(["rm", "--force", name]); } catch { /* Remove only this test's two random names. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
