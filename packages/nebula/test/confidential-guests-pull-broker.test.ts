import assert from "node:assert/strict";
import test from "node:test";
import { AttestedPullBroker, pullBrokerPolicy, sha256Hex, type AttestedPullBrokerProps } from "../src/modules/k8s/confidential-guests";
import { kindsAndNames, rawSynth, synthOf } from "./support/cdk8s-render";

const digest = (n: string) => n.repeat(64);
const brokerImage = `registry.example.com/guests/kbs@sha256:${digest("2")}`;
const initImage = `registry.example.com/guests/tools@sha256:${digest("3")}`;
const configToml = "[http_server]\ninsecure_http = true\nsockets = [\"0.0.0.0:8080\"]\n";
const primary = sha256Hex("example primary release"), bridge = sha256Hex("example bridge release");

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

const policyFor = (condition: string) => "package policy\ndefault allow := false\nallow if {\n    data.plugin == \"resource\"\n"
  + "    data[\"resource-path\"] == [\"default\", \"registry\", \"pull\"]\n"
  + "    ev := input.submods.cpu0[\"ear.veraison.annotated-evidence\"]\n"
  + `    ${condition}\n`
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

test("the 'equals' form renders byte-identically to the hand-written broker manifests", () => {
  const policy = policyFor(`ev.init_data == "${primary}"`);
  assert.equal(pullBrokerPolicy(["default", "registry", "pull"], { form: "equals", value: primary }), policy);
  const rendered = render(props());
  assert.equal(rendered.yaml, rawSynth(manifests(policy, false)).yaml);
  assert.deepEqual(kindsAndNames(rendered.objects), ["NetworkPolicy/ingress-boundary", "NetworkPolicy/pull-broker-from-guests",
    "ConfigMap/pull-broker-configuration", "Service/pull-broker", "Deployment/pull-broker"]);
});

test("the 'in' form admits exactly the listed init-data hashes, in order, and can expose the pull secret as a resource", () => {
  const policy = policyFor(`ev.init_data in ["${bridge}","${primary}"]`);
  const initData = { form: "in", values: [bridge, primary] } as const;
  assert.equal(pullBrokerPolicy(["default", "registry", "pull"], initData), policy);
  const rendered = render(props({ initData, pullSecret: { name: "registry-pull", exposeAsResource: true } }));
  assert.equal(rendered.yaml, rawSynth(manifests(policy, true)).yaml);
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
