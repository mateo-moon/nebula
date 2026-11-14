import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { request as secureRequest } from "node:https";
import { mkdirSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { test } from "node:test";
import { gateway, loadOrCreateIdentity } from "../src/gateway.ts";
import { collateralProxy } from "../src/snp-collateral.ts";

const guestMemory = process.platform === "linux" &&
  (() => { try { return Number(statfsSync("/dev/shm").type) === 0x01021994; } catch { return false; } })();
const listen = async server => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const call = (port, path, secure = false, method = "GET") => new Promise((resolve, reject) => {
  const req = (secure ? secureRequest : request)({ host: "127.0.0.1", port, path, method,
    ...(secure ? { rejectUnauthorized: false } : {}) }, response => {
    response.resume(); response.once("end", () => resolve(response.statusCode));
  });
  req.once("error", reject); req.end();
});

test("incomplete owner custody refuses requests without crashing or reopening a claim", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-incomplete-owner-");
  let server;
  try {
    mkdirSync(`${directory}/claimed-owner`, { mode: 0o700 });
    server = gateway({ ...loadOrCreateIdentity(directory), claim: { sha256: "a".repeat(64), audience: "example",
      directory, internalOwnerKey: Buffer.alloc(0) } });
    const port = await listen(server);
    assert.equal(await call(port, "/nebula/v1/instance", true), 503);
    assert.equal(await call(port, "/nebula/v1/claim", true, "POST"), 503);
    assert.equal(await call(port, "/nebula/v1/ready", true), 503);
    assert.equal(server.listening, true);
  } finally { if (server) await close(server); rmSync(directory, { recursive: true, force: true }); }
});

test("a private owner port conflict is reported through the managed TLS server", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-owner-listener-");
  const occupied = createServer(); occupied.listen(8447, "127.0.0.1"); await once(occupied, "listening");
  let server;
  try {
    server = gateway({ ...loadOrCreateIdentity(directory), browser: true });
    const error = await new Promise(resolve => server.once("error", resolve));
    assert.equal(error.message, "Private owner listener failed");
  } finally { if (server) await close(server); await close(occupied); rmSync(directory, { recursive: true, force: true }); }
});

test("malformed collateral request targets return400 and the proxy keeps serving", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ fixture: true })));
  const server = collateralProxy(0); await once(server, "listening");
  try {
    const port = server.address().port;
    assert.equal(await call(port, "//"), 400);
    assert.equal(await call(port, "/info"), 200);
    assert.equal(await call(port, "//"), 400);
    assert.equal(server.listening, true);
  } finally { await close(server); }
});

test("recovery and supervision require actual owner authorization before local state or mutation", { skip: !guestMemory }, async () => {
  const directory = mkdtempSync("/dev/shm/nebula-recovery-auth-");
  let server, upstream, mutations=0, reads=0;
  const authenticated = (port,path,method="GET",token="bad",body) => new Promise((resolve,reject)=>{
    const req=secureRequest({host:"127.0.0.1",port,path,method,rejectUnauthorized:false,
      headers:{Authorization:`Bearer ${token}`}},response=>{const chunks=[];response.on("data",c=>chunks.push(c));response.on("end",()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()}));});
    req.on("error",reject);req.end(body ? JSON.stringify(body):undefined);
  });
  try {
    upstream=createServer((req,res)=>{req.resume();res.writeHead(req.headers.authorization==="Bearer valid"?200:401).end();});
    const upstreamPort=await listen(upstream);
    server=gateway({...loadOrCreateIdentity(directory),upstreamPort,recovery:{
      async plans(){reads++;return {version:1,instance:"a".repeat(64),plans:[]};},
      async apply(value){mutations++;if(value.version!==1)throw Error();return {version:1,storage:"data",accepted:true};}
    }});const port=await listen(server);
    for(const path of ["/nebula/v1/storage-recovery","/nebula/v1/supervisors"]){
      assert.equal(await call(port,path,true),403);
      assert.equal((await authenticated(port,path)).status,403);
    }
    assert.equal((await authenticated(port,"/nebula/v1/storage-recovery","POST","bad",{version:1})).status,403);
    assert.equal(reads,0);assert.equal(mutations,0);
    assert.equal((await authenticated(port,"/nebula/v1/storage-recovery","GET","valid")).status,200);
    assert.equal((await authenticated(port,"/nebula/v1/storage-recovery","POST","valid",{version:1})).status,202);
    assert.equal((await authenticated(port,"/nebula/v1/storage-recovery","POST","valid",{version:2})).status,409);
    assert.equal(reads,1);assert.equal(mutations,2);
    const supervisors=await authenticated(port,"/nebula/v1/supervisors","GET","valid");
    assert.equal(supervisors.status,200);assert.deepEqual(JSON.parse(supervisors.body),{version:1,storage:{}});
  } finally {if(server)await close(server);if(upstream)await close(upstream);rmSync(directory,{recursive:true,force:true});}
});
