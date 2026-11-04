import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const name = `nebula-agent-${randomUUID()}`;
const image = process.env.CONFIDENTIAL_AGENT_TEST_IMAGE ?? "nebula-confidential-agent:ci";
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 90_000 });
const config = { version: 1, role: "workload", owner: { storageNames: [], resources: ["default/image/app", "default/config/app"] },
  storage: { version: 1, volumes: [], clients: [{ name: "app", uid: 11000, gid: 11000, resources: ["default/config/app"] }],
    deniedResources: ["default/image/app", "default/volume/data"] } };
const args = ["create", "--name", name, "--platform", "linux/amd64", "--network", "none", "--read-only",
  "--user", "0:0", "--group-add", "10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
  "--memory", "512m", "--pids-limit", "128"];
for (const cap of ["NET_ADMIN", "SYS_ADMIN", "MKNOD", "CHOWN", "SETUID", "SETGID", "SETPCAP"]) args.push("--cap-add", cap);
for (const [path, uid, mode] of [["/tmp", 10001, "0700"], ["/run/instance", 10001, "0770"],
  ["/run/nebula-guard", 0, "0755"], ["/run/nebula-owner-ready", 10001, "0770"],
  ["/run/nebula-runtime", 0, "0755"], ["/run/nebula-resources/app", 0, "0755"]]) {
  args.push("--tmpfs", `${path}:rw,nosuid,nodev,size=16m,uid=${uid},gid=10001,mode=${mode}`);
}
// Local process-boundary tests may emulate a swap-free guest kernel view.
// This test-only mount is never part of a rendered confidential Pod or image.
if (process.env.CONFIDENTIAL_AGENT_TEST_SWAPS) {
  args.push("--mount", `type=bind,src=${process.env.CONFIDENTIAL_AGENT_TEST_SWAPS},dst=/proc/swaps,readonly`);
  console.log("Offline kernel-view fixture selected; this run does not qualify TEE attestation or swap isolation.");
}
docker([...args, image, JSON.stringify(config)]);
const exec = (uid, code) => docker(["exec", "--user", `${uid}:${uid}`, name, "node", "--input-type=module", "-e", code]);
try {
  docker(["start", name]);
  exec(10001, `
    import assert from 'node:assert/strict'; import {readFileSync,openSync} from 'node:fs';
    import {request} from 'node:https'; import {setTimeout} from 'node:timers/promises';
    const get = () => new Promise((resolve,reject) => {
      const req=request({hostname:'127.0.0.1',port:8444,path:'/nebula/v1/configured',rejectUnauthorized:false},res=>{
        let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve(JSON.parse(data)));
      });req.on('error',reject);req.end();
    });
    let ready;
    for(let attempt=0;attempt<100;attempt++){try{ready=await get();break;}catch{await setTimeout(100);}}
    assert.equal(ready?.configured,false,'compiled agent did not start or bypassed its owner gate');
    const startup=await new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:8444,path:'/nebula/v1/ready',rejectUnauthorized:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
    });
    assert.equal(startup,503,'kubelet could pull the encrypted application before owner provisioning');
    const status=readFileSync('/proc/1/status','utf8');
    assert.match(status,/Uid:\\s+10001\\s+10001\\s+10001\\s+10001/);
    for(const capability of ['CapEff','CapPrm','CapInh','CapAmb'])assert.match(status,new RegExp(capability+':\\\\s+0+'));
    assert.match(status,/NoNewPrivs:\\s+1/);
    assert.throws(()=>process.setuid(0));
    const pid=readFileSync('/proc/1/task/1/children','utf8').trim().split(/\\s+/)[0];
    assert.ok(pid,'the private native module did not start');
    const native=readFileSync('/proc/'+pid+'/status','utf8');
    const keep=(1n<<0n)|(1n<<21n)|(1n<<27n);
    for(const field of ['CapEff','CapPrm','CapBnd'])assert.equal(BigInt('0x'+native.match(new RegExp(field+':\\\\s+([0-9a-f]+)'))[1]),keep);
    assert.throws(()=>openSync('/proc/'+pid+'/mem','r'),'HTTP agent read native key memory');
    assert.throws(()=>process.kill(Number(pid),'SIGTERM'),{code:'EPERM'},'HTTP agent retained native signal privileges');
    console.log('Compiled agent drops HTTP privileges and restricts its private native module.');
  `);
  // Fixed loopback fixtures stand in for native KBS/CDH; no attestation verdict
  // or production identity is invented by this offline process-boundary test.
  docker(["exec", "--detach", "--user", "10001:10001", name, "node", "--input-type=module", "-e", `
    import {createServer} from 'node:http';let reads=0,available=false;
    createServer((req,res)=>{req.resume();res.end('[]');}).listen(8080,'127.0.0.1');
    createServer((req,res)=>{req.resume();reads++;res.writeHead(available?200:404).end(available?'synthetic-approved-resource':'');}).listen(8006,'127.0.0.1');
    createServer((req,res)=>{if(req.url==='/publish')available=true;res.end(String(reads));}).listen(8082,'127.0.0.1');
  `]);
  exec(10001, `
    import assert from 'node:assert/strict';import {request} from 'node:https';import {existsSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';
    for(let attempt=0;attempt<100;attempt++){try{await fetch('http://127.0.0.1:8082');break;}catch{await setTimeout(100);}}
    const call=(path,method='GET')=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:8444,path,method,rejectUnauthorized:false,headers:{Authorization:'Bearer synthetic.owner'}},res=>{
        res.resume();res.on('end',()=>resolve(res.statusCode));
      });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
    });
    assert.equal(await(await fetch('http://127.0.0.1:8082')).text(),'0','native resources read before owner policy');
    assert.equal(await call('/kbs/v0/resource/default/volume/data'),403);
    assert.equal(await call('/kbs/v0/resource/default/image/app'),403);
    assert.equal(await call('/kbs/v0/resource-policy','POST'),200);
    assert.equal(await call('/kbs/v0/attestation-policy','POST'),200);
    assert.equal(await call('/nebula/v1/ready'),503,'policies alone opened the encrypted image pull gate');
    assert.equal(existsSync('/run/nebula-owner-ready/ready'),false,'missing resource keys were ignored');
    await fetch('http://127.0.0.1:8082/publish');
    for(let attempt=0;attempt<100&&!existsSync('/run/nebula-owner-ready/ready');attempt++)await setTimeout(100);
    assert.ok(existsSync('/run/nebula-owner-ready/ready'),'in-process owner gate did not publish readiness');
    assert.equal(await call('/nebula/v1/ready'),200,'kubelet startup gate did not open after resource availability');
    console.log('Native resource reads stay behind owner policy; remote image/disk-key reads are denied.');
  `);
  exec(11000, `
    import assert from 'node:assert/strict';import {connect} from 'node:net';import {request} from 'node:https';
    const read=path=>new Promise((resolve,reject)=>{
      const socket=connect('/run/nebula-resources/app/resource.sock',()=>socket.write('GET '+path+'\\n'));
      let bytes=Buffer.alloc(0);socket.on('data',chunk=>bytes=Buffer.concat([bytes,chunk]));
      socket.on('error',reject);socket.on('end',()=>resolve(bytes));
    });
    assert.ok((await read('default/config/app')).subarray(4).equals(Buffer.from('synthetic-approved-resource')));
    for(const path of ['default/image/app','default/volume/data'])assert.equal((await read(path)).length,0);
    for(const port of [8006,8080])await assert.rejects(fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(2000)}));
    await assert.rejects(new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:8444,path:'/nebula/v1/configured',rejectUnauthorized:false},resolve);
      req.setTimeout(2000,()=>req.destroy(new Error('private API unavailable')));req.on('error',reject);req.end();
    }));
    console.log('Application receives its allowlisted resource and cannot read image/disk keys or reach private APIs.');
  `);
  const stopping = Date.now();
  docker(["stop", "--time", "75", name]);
  assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", name]).trim(), "0", "agent needed a forced kill");
  assert.ok(Date.now() - stopping < 10_000, "idle native module did not stop promptly over its private channel");
  console.log("Single-agent startup, privilege separation, readiness and clean shutdown passed offline.");
} finally { docker(["rm", "--force", name]); }
