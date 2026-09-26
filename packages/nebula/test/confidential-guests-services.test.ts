import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { GuestServices, type GuestServicesProps } from "../src/modules/k8s/confidential-guests";
import { DOMAIN, NAMESPACE } from "./confidential-guests-fixtures";

const primary = { app: "guests", role: "primary" }, operator = { app: "guests", role: "operator" };
const holder = { ...primary, [`${DOMAIN}/lifecycle`]: "holder" };
const render = (value: GuestServicesProps) => {
  const chart = Testing.chart();
  new GuestServices(chart, "services", value);
  return Testing.synth(chart);
};

test("ingress policies first, then Services, exactly as declared", () => {
  const annotations = { "argocd.argoproj.io/sync-wave": "-2" };
  const meta = (name: string) => ({ name, namespace: NAMESPACE, annotations });
  assert.deepEqual(render({
    namespace: NAMESPACE,
    ingress: [
      { name: "primary-control", podSelector: primary, ports: [7443], from: [operator] },
      { name: "operator-access", podSelector: operator, ports: [8080, 2222] },
    ],
    services: [
      { name: "guest-primary", selector: holder, ports: [7443, 7445], clusterIP: "192.0.2.10", publishNotReadyAddresses: true },
      { name: "guest-operator", selector: operator, ports: [8080], clusterIP: "2001:db8::10", publishNotReadyAddresses: false },
      { name: "guest-any", selector: operator, ports: [8080] },
    ],
  }), [
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("primary-control"), spec: {
      podSelector: { matchLabels: primary }, policyTypes: ["Ingress"],
      ingress: [{ from: [{ podSelector: { matchLabels: operator } }], ports: [{ port: 7443, protocol: "TCP" }] }] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta("operator-access"), spec: {
      podSelector: { matchLabels: operator }, policyTypes: ["Ingress"],
      ingress: [{ ports: [{ port: 8080, protocol: "TCP" }, { port: 2222, protocol: "TCP" }] }] } },
    { apiVersion: "v1", kind: "Service", metadata: meta("guest-primary"), spec: {
      clusterIP: "192.0.2.10", selector: holder, publishNotReadyAddresses: true,
      ports: [{ name: "tcp-7443", port: 7443, targetPort: 7443, protocol: "TCP" }, { name: "tcp-7445", port: 7445, targetPort: 7445, protocol: "TCP" }] } },
    { apiVersion: "v1", kind: "Service", metadata: meta("guest-operator"), spec: {
      clusterIP: "2001:db8::10", selector: operator, publishNotReadyAddresses: false,
      ports: [{ name: "tcp-8080", port: 8080, targetPort: 8080, protocol: "TCP" }] } },
    { apiVersion: "v1", kind: "Service", metadata: meta("guest-any"), spec: {
      selector: operator, ports: [{ name: "tcp-8080", port: 8080, targetPort: 8080, protocol: "TCP" }] } },
  ]);
});

test("inputs are checked", () => {
  const service = { name: "guest-a", selector: primary, ports: [8080] };
  const refusals: [string, Partial<GuestServicesProps>, RegExp][] = [
    ["nothing", {}, /nothing to render/],
    ["empty selector", { services: [{ ...service, selector: {} }] }, /selector/],
    ["bad label", { services: [{ ...service, selector: { "a b": "c" } }] }, /label key/],
    ["bad port", { services: [{ ...service, ports: [70000] }] }, /port/],
    ["no ports", { services: [{ ...service, ports: [] }] }, /ports/],
    ["duplicate port", { services: [{ ...service, ports: [8080, 8080] }] }, /twice/],
    ["bad address", { services: [{ ...service, clusterIP: "guest.example.com" }] }, /clusterIP/],
    ["duplicate Service", { services: [service, service] }, /twice/],
    ["duplicate policy", { ingress: [{ name: "p", podSelector: primary, ports: [1] }, { name: "p", podSelector: primary, ports: [1] }] }, /twice/],
    ["empty source list", { ingress: [{ name: "p", podSelector: primary, ports: [1], from: [] }] }, /from/],
    ["bad name", { services: [{ ...service, name: "Guest" }] }, /Service name/],
    ["bad wave", { services: [service], wave: "x" }, /wave/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render({ namespace: NAMESPACE, ...change }), error, label);
});
