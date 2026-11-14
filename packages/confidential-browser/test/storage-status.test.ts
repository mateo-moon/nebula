import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedSupervisors, storageClientsRunning, checkedStorageRecovery } from "../src/ui/storage-status";
const instance="a".repeat(64);
test("supervisor backoff, stop and absent leases cannot claim startup completion",()=>{
 for(const phase of ["starting","backoff","stopped","running"]){const report=checkedSupervisors({version:1,storage:{data:{available:true,clients:{app:{phase,restartCount:2,applicationReady:null}}}}});assert.equal(storageClientsRunning(report,["data"]),phase==="running");}
 assert.equal(storageClientsRunning(checkedSupervisors({version:1,storage:{}}),["data"]),false);
 assert.throws(()=>checkedSupervisors({version:1,storage:{data:{available:true,clients:{app:{phase:"running",restartCount:0,applicationReady:true}}}}}));
});
test("storage recovery plans bind the enrolled SPKI, declared key route, sealed header and bounded challenge",()=>{
 const plan={version:1,storage:"data",keyResource:"default/volume/data",instance,headerSha256:"b".repeat(64),challenge:"c".repeat(64),action:"initialize-empty-filesystem",expiresInSeconds:60};
 assert.equal(checkedStorageRecovery({version:1,instance,plans:[plan]},instance,{data:plan.keyResource}).length,1);
 for(const changed of [{instance:"d".repeat(64)},{keyResource:"default/volume/other"},{headerSha256:"bad"},{expiresInSeconds:301},{action:"format-any-disk"}])assert.throws(()=>checkedStorageRecovery({version:1,instance,plans:[{...plan,...changed}]},instance,{data:plan.keyResource}));
});
