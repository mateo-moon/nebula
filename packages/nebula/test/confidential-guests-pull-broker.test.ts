import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AttestedPullBroker, pullBrokerPolicy, readConfidentialGuestAsset, sha256Hex, type AttestedPullBrokerProps,
} from "../src/modules/k8s/confidential-guests";
import { kindsAndNames, rawSynth, synthOf } from "./support/cdk8s-render";

const digest = (n: string) => n.repeat(64);
const brokerImage = `registry.example.com/guests/kbs@sha256:${digest("2")}`;
const initImage = `registry.example.com/guests/tools@sha256:${digest("3")}`;
const configToml = "[http_server]\ninsecure_http = true\nsockets = [\"0.0.0.0:8080\"]\n";
const primary = sha256Hex("example primary release"), bridge = sha256Hex("example bridge release");
// SEV-SNP launch measurements are 48 bytes: the size of a SHA-384 digest.
const launch = (name: string) => createHash("sha384").update(name).digest("hex");
const primaryLaunch = launch("example primary launch"), bridgeLaunch = launch("example bridge launch");

const props = (change: Partial<AttestedPullBrokerProps> = {}): AttestedPullBrokerProps => ({
  namespace: "guests",
  name: "pull-broker",
  configMapName: "pull-broker-configuration",
  networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
  podLabels: { app: "guests-pull-broker" },
  guestSelector: { app: "confidential-guest" },
  nodeName: "guest-host-1",
  brokerImage,
  initImage,
  initCommand: ["python3", "/opt/tools/registry_init.py"],
  configToml,
  resourcePath: ["default", "registry", "pull"],
  initData: { form: "equals", value: primary },
  pullSecret: { name: "registry-pull", exposeAsResource: false },
  labelDomain: "guests.example.com",
  imagePullSecrets: ["registry-pull"],
  ...change,
});
const render = (value: AttestedPullBrokerProps) => synthOf(chart => new AttestedPullBroker(chart, "broker", value));

test("scheduler placement preserves broker security and policies while respecting managed-worker drains", () => {
  const legacy = render(props()).objects;
  const nodeSelector = { "kubernetes.io/hostname": "worker-1" };
  const tolerations = [{ key: "workload", operator: "Equal", value: "tool-node", effect: "NoSchedule" }];
  const scheduled = render(props({ nodeName: undefined, nodeSelector, tolerations })).objects;
  const expected = structuredClone(legacy);
  const pod = expected.find(object => object.kind === "Deployment").spec.template.spec;
  delete pod.nodeName;
  pod.nodeSelector = nodeSelector;
  pod.tolerations = tolerations;
  assert.deepEqual(scheduled, expected, "only scheduling fields may change; credentials and key-release policy stay identical");
  assert.throws(() => render(props({ nodeSelector })), /exactly one/);
  assert.throws(() => render(props({ nodeName: undefined })), /exactly one/);
  assert.throws(() => render(props({ nodeName: undefined, nodeSelector: {} })), /nodeSelector/);
  assert.throws(() => render(props({ tolerations })), /scheduler-managed/);
});

const policyFor = (...conditions: string[]) => "package policy\ndefault allow := false\nallow if {\n    data.plugin == \"resource\"\n"
  + "    data[\"resource-path\"] == [\"default\", \"registry\", \"pull\"]\n"
  + "    ev := input.submods.cpu0[\"ear.veraison.annotated-evidence\"]\n"
  + conditions.map(condition => `    ${condition}\n`).join("")
  + "    ev.snp.policy_debug_allowed == false\n}\n";

// The broker as plain manifests, in the shape they were first written by hand.
const restricted = { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
const manifests = (policy: string, exposeAsResource: boolean) => {
  const metadata = (name: string, wave: string) => ({ name, namespace: "guests", annotations: { "argocd.argoproj.io/sync-wave": wave } });
  return [
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("ingress-boundary", "-2"),
      spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("pull-broker-from-guests", "-2"),
      spec: { podSelector: { matchLabels: { app: "guests-pull-broker" } }, policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { app: "confidential-guest" } } }], ports: [{ port: 8080, protocol: "TCP" }] }] } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: metadata("pull-broker-configuration", "-2"), data: {
      "config.toml": configToml,
      "resource-policy.rego": policy,
    } },
    { apiVersion: "v1", kind: "Service", metadata: metadata("pull-broker", "-2"),
      spec: { selector: { app: "guests-pull-broker" }, ports: [{ name: "http", port: 8080, targetPort: 8080 }] } },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: metadata("pull-broker", "-1"),
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: "guests-pull-broker" } },
        template: { metadata: { labels: { app: "guests-pull-broker" },
          annotations: { "guests.example.com/config-sha256": sha256Hex(policy + configToml) } },
          spec: { nodeName: "guest-host-1", automountServiceAccountToken: false,
            imagePullSecrets: [{ name: "registry-pull" }],
            initContainers: [{ name: "initialize-registry", image: initImage,
              command: ["python3", "/opt/tools/registry_init.py"], securityContext: restricted,
              volumeMounts: [{ name: "state", mountPath: "/state" }, { name: "registry", mountPath: "/registry", readOnly: true },
                { name: "configuration", mountPath: "/configuration", readOnly: true }] }],
            containers: [{ name: "broker", image: brokerImage, securityContext: restricted,
              command: ["/usr/local/bin/kbs", "--config-file", "/configuration/config.toml"],
              env: [{ name: "RUST_LOG", value: "info" }],
              resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
              ports: [{ name: "http", containerPort: 8080 }], readinessProbe: { tcpSocket: { port: "http" }, periodSeconds: 2 },
              volumeMounts: [{ name: "state", mountPath: "/state" }, { name: "configuration", mountPath: "/configuration", readOnly: true },
                ...(exposeAsResource ? [{ name: "registry-resource", mountPath: "/state/repository", readOnly: true }] : [])] }],
            volumes: [{ name: "state", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
              { name: "registry", secret: { secretName: "registry-pull", defaultMode: 256 } },
              { name: "configuration", configMap: { name: "pull-broker-configuration" } },
              ...(exposeAsResource ? [{ name: "registry-resource", secret: { secretName: "registry-pull", defaultMode: 256,
                items: [{ key: ".dockerconfigjson", path: "default\\x2Fregistry\\x2Fpull" }] } }] : [])],
          } } } },
  ];
};

// The opt-in modes, as edits of the hand-written manifests: the read-only
// policy adds a ConfigMap projection at /state/kbs; the ephemeral issuer also
// replaces the caller's init with the shipped one in the broker image, which
// mounts only /state, and drops the credential mount it no longer needs.
const optIn = (policy: string, exposeAsResource: boolean, ephemeral: boolean) => {
  const objects: any[] = structuredClone(manifests(policy, exposeAsResource));
  const pod = objects.at(-1).spec.template.spec;
  const at = (list: any[], name: string) => list.findIndex(entry => entry.name === name) + 1;
  const broker = pod.containers[0];
  broker.volumeMounts.splice(at(broker.volumeMounts, "configuration"), 0, { name: "policy", mountPath: "/state/kbs", readOnly: true });
  pod.volumes.splice(at(pod.volumes, "configuration"), 0, { name: "policy", configMap: { name: "pull-broker-configuration",
    items: [{ key: "resource-policy.rego", path: "resource-policy.rego" }] } });
  if (ephemeral) {
    pod.initContainers = [{ name: "initialize-issuer", image: brokerImage, command: ["/bin/sh", "-c", readConfidentialGuestAsset("pull-broker-issuer.sh")],
      securityContext: restricted, volumeMounts: [{ name: "state", mountPath: "/state" }] }];
    pod.volumes = pod.volumes.filter((volume: any) => volume.name !== "registry");
  }
  return objects;
};

test("the 'equals' form renders byte-identically to the hand-written broker manifests", () => {
  const policy = policyFor(`ev.init_data == "${primary}"`);
  assert.equal(pullBrokerPolicy(["default", "registry", "pull"], { form: "equals", value: primary }), policy);
  const rendered = render(props());
  assert.equal(rendered.yaml, rawSynth(manifests(policy, false)).yaml);
  assert.deepEqual(kindsAndNames(rendered.objects), ["NetworkPolicy/ingress-boundary", "NetworkPolicy/pull-broker-from-guests",
    "ConfigMap/pull-broker-configuration", "Service/pull-broker", "Deployment/pull-broker"]);
});

const ephemeral = (change: Partial<AttestedPullBrokerProps> = {}) => props({
  issuer: "ephemeral", initImage: undefined, initCommand: undefined, pullSecret: { name: "registry-pull", exposeAsResource: true }, ...change,
});

test("existing brokers render as before: the ephemeral issuer and the read-only policy are opt-in", () => {
  const before = render(props()).yaml;
  assert.equal(render(props({ policyReadOnly: false })).yaml, before);
  assert.equal(render(props({ issuer: undefined, policyReadOnly: undefined })).yaml, before);
});

test("the ephemeral issuer runs the shipped init in the broker image and mounts the policy and credential read-only", () => {
  const policy = policyFor(`ev.init_data == "${primary}"`);
  const rendered = render(ephemeral());
  assert.equal(rendered.yaml, rawSynth(optIn(policy, true, true)).yaml);
  const pod = rendered.objects.at(-1).spec.template.spec;
  const [init] = pod.initContainers;
  assert.equal(init.image, pod.containers[0].image, "the init is the pinned broker image");
  assert.deepEqual(init.command, ["/bin/sh", "-c", readConfidentialGuestAsset("pull-broker-issuer.sh")]);
  assert.deepEqual(init.volumeMounts, [{ name: "state", mountPath: "/state" }], "the init sees neither the credential nor the policy");
  assert.deepEqual(pod.volumes.filter((v: any) => v.secret).map((v: any) => v.name), ["registry-resource"],
    "the credential is projected only as the broker's resource");
  const mounts = Object.fromEntries(pod.containers[0].volumeMounts.map((m: any) => [m.mountPath, m.readOnly === true]));
  assert.deepEqual(mounts, { "/state": false, "/configuration": true, "/state/kbs": true, "/state/repository": true });
  assert.equal(render(ephemeral({ policyReadOnly: true })).yaml, rendered.yaml, "the ephemeral issuer implies the read-only policy");
});

test("the read-only policy can be taken with the caller's init too", () => {
  const policy = policyFor(`ev.init_data == "${primary}"`);
  assert.equal(render(props({ policyReadOnly: true })).yaml, rawSynth(optIn(policy, false, false)).yaml);
});

test("the issuer source is unambiguous and fails closed", () => {
  const refusals: [string, AttestedPullBrokerProps, RegExp][] = [
    ["unknown issuer", props({ issuer: "static" as any }), /issuer must be "ephemeral"/],
    ["ephemeral with an init image", ephemeral({ initImage }), /initImage and initCommand must be omitted/],
    ["ephemeral with an init command", ephemeral({ initCommand: ["python3", "/opt/tools/registry_init.py"] }), /initImage and initCommand must be omitted/],
    ["ephemeral without the credential resource", ephemeral({ pullSecret: { name: "registry-pull", exposeAsResource: false } }), /exposeAsResource/],
    ["ephemeral with a writable policy", ephemeral({ policyReadOnly: false }), /policyReadOnly/],
    ["no init image", props({ initImage: undefined }), /initImage and initCommand are required/],
    ["no init command", props({ initCommand: undefined }), /initImage and initCommand are required/],
    ["policy flag", props({ policyReadOnly: "yes" as any }), /policyReadOnly must be a boolean/],
  ];
  for (const [label, value, error] of refusals) assert.throws(() => render(value), error, label);
});

test("the 'in' form admits exactly the listed init-data hashes, in order, and can expose the pull secret as a resource", () => {
  const policy = policyFor(`ev.init_data in ["${bridge}","${primary}"]`);
  const initData = { form: "in", values: [bridge, primary] } as const;
  assert.equal(pullBrokerPolicy(["default", "registry", "pull"], initData), policy);
  const rendered = render(props({ initData, pullSecret: { name: "registry-pull", exposeAsResource: true } }));
  assert.equal(rendered.yaml, rawSynth(manifests(policy, true)).yaml);
});

test("a pinned launch measurement is admitted right after the init-data, as one value or a list, and rolls the broker", () => {
  const path = ["default", "registry", "pull"] as const;
  const initData = { form: "equals", value: primary } as const;
  const one = policyFor(`ev.init_data == "${primary}"`, `ev.snp.measurement == "${primaryLaunch}"`);
  assert.equal(pullBrokerPolicy(path, initData, { form: "equals", value: primaryLaunch }), one);
  const measurement = { form: "in", values: [bridgeLaunch, primaryLaunch] } as const;
  const any = policyFor(`ev.init_data == "${primary}"`, `ev.snp.measurement in ["${bridgeLaunch}","${primaryLaunch}"]`);
  assert.equal(pullBrokerPolicy(path, initData, measurement), any);
  const rendered = render(props({ measurement })), without = render(props());
  assert.equal(rendered.yaml, rawSynth(manifests(any, false)).yaml);
  const hash = (deployment: any) => deployment.spec.template.metadata.annotations["guests.example.com/config-sha256"];
  assert.equal(hash(rendered.objects.at(-1)), sha256Hex(any + configToml));
  assert.notEqual(hash(rendered.objects.at(-1)), hash(without.objects.at(-1)), "pinning a measurement rolls the broker");
  assert.equal(pullBrokerPolicy(path, initData, undefined), pullBrokerPolicy(path, initData));
  assert.equal(render(props({ measurement: undefined })).yaml, without.yaml, "without a measurement the policy is as it was");
});

test("launch measurements are reviewed nonzero 48-byte values in lowercase hex", () => {
  const bad: unknown[] = ["", primaryLaunch.slice(1), `${primaryLaunch}0`, primaryLaunch.toUpperCase(), "0".repeat(96), primary, 42, null];
  for (const value of bad) {
    assert.throws(() => render(props({ measurement: { form: "equals", value } as any })), /launch measurements must be nonzero/, String(value));
    assert.throws(() => render(props({ measurement: { form: "in", values: [primaryLaunch, value] } as any })), /launch measurements must be nonzero/,
      String(value));
  }
  for (const measurement of [{ form: "in", values: [] }, { form: "any" }, { form: "equals", value: primaryLaunch, values: [primaryLaunch] }, null, primaryLaunch]) {
    assert.throws(() => render(props({ measurement: measurement as any })), /measurement admission must be/, JSON.stringify(measurement));
  }
});

test("the configuration hash annotation lives under the caller's label domain and covers policy and config", () => {
  for (const labelDomain of ["guests.example.com", "confidential.example.org", "a.b.example.net"]) {
    const broker = synthOf(chart => new AttestedPullBroker(chart, "broker", props({ labelDomain }))).objects.at(-1);
    const annotations = broker.spec.template.metadata.annotations;
    assert.deepEqual(Object.keys(annotations), [`${labelDomain}/config-sha256`]);
    const configMap = synthOf(chart => new AttestedPullBroker(chart, "broker", props({ labelDomain }))).objects[2];
    assert.equal(annotations[`${labelDomain}/config-sha256`], sha256Hex(configMap.data["resource-policy.rego"] + configMap.data["config.toml"]));
  }
  for (const labelDomain of [undefined, "", "example", "Guests.example.com", "guests..example.com", "-a.example.com", "kubernetes.io",
    "node.k8s.io", "guests.example.com/", "a".repeat(250) + ".com"]) {
    assert.throws(() => render(props({ labelDomain: labelDomain as any })), /labelDomain/, String(labelDomain));
  }
});

test("init-data hashes are reviewed nonzero SHA-256 values", () => {
  const bad: unknown[] = ["", primary.slice(1), primary.toUpperCase(), "0".repeat(64), `${primary}0`, 42, null];
  for (const value of bad) {
    assert.throws(() => render(props({ initData: { form: "equals", value } as any })), /init-data/, String(value));
    assert.throws(() => render(props({ initData: { form: "in", values: [primary, value] } as any })), /init-data/, String(value));
  }
  assert.throws(() => render(props({ initData: { form: "in", values: [] } })), /init-data/);
  assert.throws(() => render(props({ initData: { form: "any" } as any })), /init-data/);
  assert.throws(() => render(props({ initData: { form: "equals", value: primary, values: [primary] } as any })), /init-data/);
});

test("the resource path names one KBS resource and is escaped for the local store", () => {
  const deployment = render(props({ resourcePath: ["repo-a", "kind_b", "tag.c"], pullSecret: { name: "registry-pull", exposeAsResource: true } })).objects.at(-1);
  const volume = deployment.spec.template.spec.volumes.find((v: any) => v.name === "registry-resource");
  assert.deepEqual(volume.secret.items, [{ key: ".dockerconfigjson", path: "repo-a\\x2Fkind_b\\x2Ftag.c" }]);
  for (const resourcePath of [["a", "b"], ["a", "b", "c", "d"], ["a", "", "c"], ["a", "b/c", "d"], ["a", "b", "c\""], ["a", "b", ".."]]) {
    assert.throws(() => render(props({ resourcePath: resourcePath as any })), /resourcePath/, JSON.stringify(resourcePath));
  }
});

test("names, selectors, images and commands are validated", () => {
  const refusals: [string, Partial<AttestedPullBrokerProps>, RegExp][] = [
    ["namespace", { namespace: "Guests" }, /namespace/],
    ["service name", { name: "1broker" }, /name/],
    ["config map name", { configMapName: "a_b" }, /configMapName/],
    ["policy name", { networkPolicyNames: { ingressBoundary: "", fromGuests: "x" } }, /networkPolicyNames/],
    ["empty guest selector", { guestSelector: {} }, /guestSelector/],
    ["empty broker labels", { podLabels: {} }, /podLabels/],
    ["label value", { guestSelector: { app: "not valid" } }, /guestSelector/],
    ["broker image", { brokerImage: "registry.example.com/guests/kbs:v1" }, /digestImage/],
    ["init image", { initImage: "kbs@sha256:" + digest("4") }, /digestImage/],
    ["init command", { initCommand: [] }, /initCommand/],
    ["config", { configToml: "" }, /configToml/],
    ["pull secret", { pullSecret: { name: "", exposeAsResource: false } }, /pullSecret/],
    ["pull secret flag", { pullSecret: { name: "registry-pull" } as any }, /pullSecret/],
    ["port", { port: 0 }, /port/],
    ["wave", { syncWaves: { config: 0.5 } }, /syncWaves/],
    ["misspelt wave", { syncWaves: { brokr: -1 } } as any, /unknown field brokr/],
    ["misspelt prop", { initdata: { form: "equals", value: primary } } as any, /unknown field initdata/],
    ["misspelt measurement", { measurements: { form: "equals", value: primaryLaunch } } as any, /unknown field measurements/],
    ["pull secret field", { pullSecret: { name: "registry-pull", exposeAsResource: true, key: "x" } } as any, /unknown field key/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(props(change)), error, label);
});

test("the broker publishes where guests reach it and the resource they request", () => {
  let broker!: AttestedPullBroker;
  synthOf(chart => { broker = new AttestedPullBroker(chart, "broker", props({ port: 8443, syncWaves: { config: -4, broker: -3 } })); });
  assert.equal(broker.endpoint(), "http://pull-broker.guests.svc.cluster.local:8443");
  assert.equal(broker.endpoint("cluster.example"), "http://pull-broker.guests.svc.cluster.example:8443");
  assert.equal(broker.resourceUri, "kbs:///default/registry/pull");
  assert.equal(broker.policy, pullBrokerPolicy(["default", "registry", "pull"], { form: "equals", value: primary }));
  const objects = synthOf(chart => new AttestedPullBroker(chart, "broker", props({ port: 8443, syncWaves: { config: -4, broker: -3 } }))).objects;
  assert.deepEqual(objects.map(o => o.metadata.annotations["argocd.argoproj.io/sync-wave"]), ["-4", "-4", "-4", "-4", "-3"]);
  assert.deepEqual(objects[3].spec.ports, [{ name: "http", port: 8443, targetPort: 8443 }]);
  assert.deepEqual(objects[1].spec.ingress[0].ports, [{ port: 8443, protocol: "TCP" }]);
  assert.deepEqual(objects[4].spec.template.spec.containers[0].ports, [{ name: "http", containerPort: 8443 }]);
});

test("additional sealed resources have the same attestation gate and read-only store", () => {
  const { objects } = render(props({ issuer: "ephemeral", initImage: undefined, initCommand: undefined,
    pullSecret: { name: "broker-resources", exposeAsResource: true },
    additionalResources: [{ resourcePath: ["default", "tls", "client-key"], secretKey: "client-key.pem" }],
  }));
  const policy = objects.find(o => o.kind === "ConfigMap").data["resource-policy.rego"];
  assert.equal((policy.match(/package policy/g) ?? []).length, 1);
  assert.equal((policy.match(new RegExp(primary, "g")) ?? []).length, 2);
  assert.equal((policy.match(/policy_debug_allowed == false/g) ?? []).length, 2);
  assert.ok(policy.includes('["default", "tls", "client-key"]'));
  const volume = objects.find(o => o.kind === "Deployment").spec.template.spec.volumes.find((v: any) => v.name === "registry-resource");
  assert.deepEqual(volume.secret.items[1], { key: "client-key.pem", path: "default\\x2Ftls\\x2Fclient-key" });
  for (const resource of [
    { resourcePath: ["default", "registry", "pull"], secretKey: "key" },
    { resourcePath: ["default", "tls", "key"], secretKey: "../key" },
  ]) assert.throws(() => render(props({ pullSecret: { name: "resources", exposeAsResource: true }, additionalResources: [resource as any] })));
  assert.throws(() => render(props({ additionalResources: [{ resourcePath: ["default", "tls", "key"], secretKey: "key" }] })));
});
