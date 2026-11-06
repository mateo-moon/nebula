import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentConfig } from "../src/config.ts";

test("the read-only init owner gate has no configurable modules or endpoints", () => {
  assert.deepEqual(parseAgentConfig('{"version":1,"role":"owner-gate"}'), { version: 1, role: "owner-gate" });
  assert.throws(() => parseAgentConfig('{"version":1,"role":"owner-gate","entry":{}}'), /Invalid measured/);
});

const workload = () => ({ version: 1, role: "workload",
  owner: { storageNames: ["data"], resources: ["default/volume/data", "default/image/app"] },
  storage: { version: 1, volumes: [{ version: 1, name: "data", sizeBytes: 67108864,
    keyResource: "default/volume/data", initialization: "Never", clients: [{ name: "app", uid: 11000, gid: 11000 }] }],
    clients: [{ name: "app", uid: 11000, gid: 11000, resources: ["default/config/app"] }],
    deniedResources: ["default/volume/data", "default/image/app"] } });

test("one measured agent configuration binds modules, recipients and private key exclusions", () => {
  assert.deepEqual(parseAgentConfig(JSON.stringify(workload())), workload());
  for (const resource of ["default/volume/data", "default/image/app"]) {
    const config = workload(); config.storage.clients[0].resources = [resource];
    assert.throws(() => parseAgentConfig(JSON.stringify(config)), /Private keys/);
  }
  const changed = workload(); changed.owner.storageNames = ["other"];
  assert.throws(() => parseAgentConfig(JSON.stringify(changed)), /modules differ/);
  for (const field of ["device", "endpoint", "key", "stateDirectory"]) {
    const config = workload(); config.storage.volumes[0][field] = "untrusted";
    assert.throws(() => parseAgentConfig(JSON.stringify(config)), /Invalid measured/);
  }
  const privileged = workload(); privileged.storage.clients[0].uid = 0;
  assert.throws(() => parseAgentConfig(JSON.stringify(privileged)));
});

test("frontend and preparation cannot activate workload modules or accept secrets in configuration", () => {
  const frontend = { version: 1, role: "frontend", entry: { preparationEndpoint: "https://preparation.example/", stackEndpoint: "https://stack.example/" } };
  assert.deepEqual(parseAgentConfig(JSON.stringify(frontend)), frontend);
  for (const url of ["https://user:password@preparation.example/", "https://preparation.example/#token", "https://preparation.example/?token=secret"]) {
    assert.throws(() => parseAgentConfig(JSON.stringify({ ...frontend, entry: { ...frontend.entry, preparationEndpoint: url } })));
  }
  assert.throws(() => parseAgentConfig(JSON.stringify({ ...frontend, storage: workload().storage })));
  assert.deepEqual(parseAgentConfig('{"version":1,"role":"preparation","maxImageSizeMiB":4096}'), { version: 1, role: "preparation", maxImageSizeMiB: 4096 });
  for (const extra of [{ imageKey: "secret" }, { sourceImage: "registry.example/plaintext" }, { maxImageSizeMiB: 4097 }]) {
    assert.throws(() => parseAgentConfig(JSON.stringify({ version: 1, role: "preparation", ...extra })));
  }
});
