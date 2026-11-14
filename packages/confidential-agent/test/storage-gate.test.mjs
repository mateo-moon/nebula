import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { monitorOwnerReadiness, ownerReady, awaitOwnerReady } from "../src/await-owner.ts";
const eligible=process.platform==="linux"&&process.getuid?.()===10001&&Number(statfsSync("/dev/shm").type)===0x01021994;
if(process.env.CONFIDENTIAL_STORAGE_GATE_TEST_TMPFS==="1"&&!eligible)throw Error("Explicit storage gate fixture requires UID10001 and guest-memory tmpfs");
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(20);}throw Error("Readiness transition did not complete");}

test("owner recovery can outlive mount-admission timeout without starting or replacing the application",{skip:!eligible,timeout:45000},async()=>{
 const directory=mkdtempSync("/dev/shm/nebula-recovery-gate-");const stop=new AbortController();let nativeReady=false,started=false,published=false;
 const monitor=monitorOwnerReadiness(stop.signal,async()=>nativeReady,value=>{published=value;},directory);monitor.catch(()=>{});
 const application=awaitOwnerReady(stop.signal,()=>ownerReady(directory)).then(()=>{started=true;});application.catch(()=>{});
 try{
  assert.equal(readFileSync(directory+"/configured","utf8"),"nebula-owner-configured-v1\n");
  await delay(31000); // Greater than the launcher/mount-admission timeout under review.
  assert.equal(started,false);assert.equal(ownerReady(directory),false);assert.equal(published,false);
  nativeReady=true;await until(()=>started);
  assert.equal(published,true);assert.equal(ownerReady(directory),true);
  nativeReady=false;await until(()=>!published);assert.equal(ownerReady(directory),true,"the application latch is not rearmed or cleared");
 }finally{stop.abort();await Promise.allSettled([monitor,application]);rmSync(directory,{recursive:true,force:true});}
});

test("memory-only broker startup and helper loss remain fail-closed without a volume marker dependency",{skip:!eligible},async()=>{
 const directory=mkdtempSync("/dev/shm/nebula-memory-broker-gate-");const stop=new AbortController();let brokerReady=false;
 const monitor=monitorOwnerReadiness(stop.signal,async()=>{if(brokerReady)throw Error("synthetic private helper loss");return false;},()=>{},directory);
 monitor.catch(()=>{});
 try{
  await delay(300);assert.equal(ownerReady(directory),false);assert.equal(readFileSync(directory+"/configured","utf8"),"nebula-owner-configured-v1\n");
  brokerReady=true;await assert.rejects(monitor,/helper loss/);assert.equal(ownerReady(directory),false);
 }finally{stop.abort();await Promise.allSettled([monitor]);rmSync(directory,{recursive:true,force:true});}
});
