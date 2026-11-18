import assert from "node:assert/strict";
import test from "node:test";
import { App, Chart } from "cdk8s";
import { IngressNginx } from "../src/modules/k8s/ingress-nginx";
import { withStubHelm } from "./helm-stub";

test("ingress retains its published addresses on shutdown without fixing an address or replica count", () => {
  withStubHelm(valuesOf => {
    new IngressNginx(new Chart(new App(), "test"), "ingress");
    const controller = valuesOf("ingress-nginx").controller;
    // Helm must receive the string: boolean false would render a bare, enabled flag.
    assert.equal(controller.extraArgs["update-status-on-shutdown"], "false");
    assert.equal(controller.extraArgs["publish-status-address"], undefined);
    assert.equal(controller.service.loadBalancerIP, undefined);
    assert.equal(controller.replicaCount, undefined);
  });
});

test("controller arguments can opt into status removal without losing other arguments", () => {
  withStubHelm(valuesOf => {
    new IngressNginx(new Chart(new App(), "test"), "ingress", {
      controller: { extraArgs: {
        "update-status-on-shutdown": "true",
        "publish-status-address": "ingress.example.test",
      } },
    });
    assert.deepEqual(valuesOf("ingress-nginx").controller.extraArgs, {
      "update-status-on-shutdown": "true",
      "publish-status-address": "ingress.example.test",
    });
  });
});

test("raw chart values can override shutdown behavior while preserving controller arguments", () => {
  withStubHelm(valuesOf => {
    new IngressNginx(new Chart(new App(), "test"), "ingress", {
      controller: { extraArgs: { "ingress-class": "edge" } },
      values: { controller: { extraArgs: { "update-status-on-shutdown": "true" } } },
    });
    assert.deepEqual(valuesOf("ingress-nginx").controller.extraArgs, {
      "update-status-on-shutdown": "true",
      "ingress-class": "edge",
    });
  });
});
