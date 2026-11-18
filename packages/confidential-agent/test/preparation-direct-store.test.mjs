import { test } from "node:test";
import assert from "node:assert/strict";
import { assertImageStoreBinding, assertPublicationInput } from "../src/preparation/publish.ts";

const store = { endpoint: "http://operator-images.example.svc:8084", writeEndpoint: "http://operator-images.example.svc:8085", repository: "example/workload" };
const connection = () => ({ version: 1, workload: { metadata: { namespace: "example", name: "workload" },
  spec: { imageStore: { ...store }, containers: [{ image: "operator-images.example.svc:8084/example/workload:release" }] } } });

test("direct publication accepts approval without collecting registry credentials or image keys", () => {
  assertPublicationInput({ applicationApproval: {} }, true);
  for (const field of ["registryUsername", "registryPassword", "approvedRegistry", "imageKey", "password", "sourceImage", "decryptionKey"]) {
    assert.throws(() => assertPublicationInput({ applicationApproval: {}, [field]: "must-stay-local" }, true));
  }
  assert.throws(() => assertPublicationInput({}, true));
});

test("discovery cannot select or downgrade image storage without the measured configuration", () => {
  assertImageStoreBinding(connection(), store);
  assert.throws(() => assertImageStoreBinding(connection()));
  const absent = connection(); delete absent.workload.spec.imageStore;
  assert.throws(() => assertImageStoreBinding(absent, store));
  assertImageStoreBinding(absent);
  for (const mutation of [
    { endpoint: "http://attacker.example:8084" }, { writeEndpoint: "http://attacker.example:8085" },
    { repository: "other/workload" }, { credentials: "forbidden" },
  ]) {
    const value = connection(); Object.assign(value.workload.spec.imageStore, mutation);
    assert.throws(() => assertImageStoreBinding(value, store));
  }
});

test("even matching store metadata cannot authorize public hosts, alternate ports or another image", () => {
  for (const mutation of [
    { endpoint: "http://registry.example:8084", writeEndpoint: "http://registry.example:8085" },
    { endpoint: "http://127.0.0.1:8084", writeEndpoint: "http://127.0.0.1:8085" },
    { endpoint: "http://operator-images.example.svc:8084/other" },
    { endpoint: "http://operator-images.example.svc:8084/?redirect=1" },
    { endpoint: Object.assign(new URL(store.endpoint), { username: "user", password: "test-only" }).href },
    { endpoint: "http://operator-images.example.svc:8085" },
    { repository: "example/other" },
  ]) {
    const value = connection(), measured = { ...store, ...mutation };
    value.workload.spec.imageStore = measured;
    assert.throws(() => assertImageStoreBinding(value, measured));
  }
  for (const image of ["registry.example/image:release", "operator-images.example.svc:8084/example/workload:other"]) {
    const value = connection(); value.workload.spec.containers[0].image = image;
    assert.throws(() => assertImageStoreBinding(value, store));
  }
});

test("legacy publication remains credential-bound while new direct mode rejects the legacy shape", () => {
  const legacy = { applicationApproval: {}, registryUsername: "owner", registryPassword: "test-only-token", approvedRegistry: "registry.example" };
  assertPublicationInput(legacy, false);
  assert.throws(() => assertPublicationInput(legacy, true));
  assert.throws(() => assertPublicationInput({ applicationApproval: {} }, false));
  assert.throws(() => assertPublicationInput({ ...legacy, imageKey: "never-accepted" }, false));
});
