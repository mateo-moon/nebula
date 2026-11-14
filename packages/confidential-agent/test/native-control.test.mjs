import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { nativeStorageControl } from "../src/agent.ts";

const program = `const net=require('node:net');const channel=new net.Socket({fd:3});
channel.write('nebula-storage-module-v1\\n');let buffer='';channel.on('data',bytes=>{
 buffer+=bytes;for(;;){const end=buffer.indexOf('\\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
 const value=JSON.parse(line);channel.write(JSON.stringify({id:value.id,result:value.op==='bind'?{bound:true}:{version:1,plans:[]}})+'\\n');}
});`;
test("native readiness is a complete line on a still-open inherited channel", async () => {
  const child=spawn(process.execPath,["-e",program],{stdio:["ignore","ignore","ignore","pipe"]});
  try {
    const control=nativeStorageControl(child);await control.ready;
    assert.equal(child.stdio[3].destroyed,false);
    assert.deepEqual(await control.bind("a".repeat(64)),{bound:true});
    assert.deepEqual(await control.plans(),{version:1,plans:[]});
  } finally { child.kill();await once(child,"exit"); }
});
test("malformed native initialization fails without accepting a control request",async()=>{
  const child=spawn(process.execPath,["-e","require('node:fs').writeSync(3,'not-ready\\n')"],{stdio:["ignore","ignore","ignore","pipe"]});
  const exited=once(child,"exit");const control=nativeStorageControl(child);
  await assert.rejects(control.ready,/unavailable/);await assert.rejects(control.plans(),/unavailable/);await exited;
});
