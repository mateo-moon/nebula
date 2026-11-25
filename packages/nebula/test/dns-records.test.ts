import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { Dns } from "../src/modules/infra/dns";

test("records use the selected zone's normalized DNS name and resource reference", () => {
  const chart = Testing.chart();
  new Dns(chart, "dns", {
    project: "example",
    zones: [
      { name: "parent", dnsName: "example.test." },
      { name: "child", dnsName: "sub.example.test" },
    ],
    records: [
      { zoneName: "child", name: "@", type: "A", rrdatas: ["192.0.2.1"] },
      { zoneName: "parent", name: "www", type: "A", rrdatas: ["192.0.2.2"] },
    ],
  });

  const records = Testing.synth(chart).filter(resource => resource.kind === "RecordSet");
  assert.deepEqual(Object.fromEntries(records.map(resource => {
    const record = resource.spec.forProvider;
    return [record.name, record.managedZoneRef.name];
  })), { "sub.example.test.": "child", "www.example.test.": "parent" });

  assert.throws(() => new Dns(Testing.chart(), "dns", {
    project: "example",
    zones: [],
    records: [{ zoneName: "missing", name: "www", type: "A", rrdatas: ["192.0.2.1"] }],
  }), /Zone 'missing' not found for record 'www'/);
});
