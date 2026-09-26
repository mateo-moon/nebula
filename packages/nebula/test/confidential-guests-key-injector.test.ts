import assert from "node:assert/strict";
import test from "node:test";
import { NriKeyInjector, type NriKeyInjectorProps } from "../src/modules/k8s/confidential-guests";
import { rawSynth, synthOf } from "./support/cdk8s-render";

const image = `registry.example.com/guests/key-injector@sha256:${"1".repeat(64)}`;
const props = (change: Partial<NriKeyInjectorProps> = {}): NriKeyInjectorProps => ({
  name: "key-injector",
  namespace: "guests",
  nodeName: "guest-host-1",
  image,
  pluginIndex: "40",
  runtimeHandler: "kata-qemu-snp",
  device: { major: 10, minor: 258 },
  bindings: [
    { pod: "guest-data", container: "storage" },
    { pod: "guest-data", container: "attest" },
    { pod: "guest-bridge", container: "storage" },
  ],
  imagePullSecrets: ["registry-pull"],
  ...change,
});
const render = (value: NriKeyInjectorProps) => synthOf(chart => new NriKeyInjector(chart, "injector", value));

// The Deployment as a plain manifest, in the shape host helpers were written
// by hand: a construct adopted in place of such a manifest must render the
// same bytes.
const restricted = { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
const manifest = ({ nri = "/var/run/nri", args = [] as string[], pullSecrets = [{ name: "registry-pull" }] as object[] | null } = {}) => ({
  apiVersion: "apps/v1", kind: "Deployment",
  metadata: { name: "key-injector", namespace: "guests", annotations: { "argocd.argoproj.io/sync-wave": "-1" } },
  spec: {
    replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: "guests-key-injector" } },
    template: {
      metadata: { labels: { app: "guests-key-injector" } },
      spec: {
        nodeName: "guest-host-1", automountServiceAccountToken: false, enableServiceLinks: false,
        ...(pullSecrets ? { imagePullSecrets: pullSecrets } : {}),
        containers: [{
          name: "injector", image, securityContext: restricted,
          args: ["--idx", "40", "--socket-path", `${nri}/nri.sock`, "--namespace", "guests", "--runtime-handler", "kata-qemu-snp",
            "--device-major", "10", "--device-minor", "258", ...args],
          volumeMounts: [{ name: "nri", mountPath: nri, readOnly: true }],
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
          ports: [{ name: "health", containerPort: 8080 }],
          readinessProbe: { httpGet: { path: "/readyz", port: "health" }, periodSeconds: 2 },
        }],
        volumes: [{ name: "nri", hostPath: { path: nri, type: "Directory" } }],
      },
    },
  },
});
const bindingArgs = ["--binding", "guest-data=storage", "--binding", "guest-data=attest", "--binding", "guest-bridge=storage"];

test("NriKeyInjector renders byte-identically to the hand-written host helper manifest", () => {
  assert.equal(render(props()).yaml, rawSynth([manifest({ args: bindingArgs })]).yaml);
  assert.equal(render(props({ imagePullSecrets: undefined })).yaml, rawSynth([manifest({ args: bindingArgs, pullSecrets: null })]).yaml);
});

test("the injector mounts the NRI socket directory, never the socket, and connects to the socket inside it", () => {
  for (const nri of ["/var/run/nri", "/run/nri"]) {
    const change = nri === "/var/run/nri" ? {} : { nriDirectory: nri };
    const [deployment] = render(props(change)).objects;
    const pod = deployment.spec.template.spec;
    assert.deepEqual(pod.volumes, [{ name: "nri", hostPath: { path: nri, type: "Directory" } }]);
    assert.deepEqual(pod.containers[0].volumeMounts, [{ name: "nri", mountPath: nri, readOnly: true }]);
    const args: string[] = pod.containers[0].args;
    assert.equal(args[args.indexOf("--socket-path") + 1], `${nri}/nri.sock`);
    assert.equal(render(props(change)).yaml, rawSynth([manifest({ nri, args: bindingArgs })]).yaml);
  }
  for (const nriDirectory of ["run/nri", "/run/nri/", "/run/nri/nri.sock", "/run/../nri", "/", "/run/nri dir"]) {
    assert.throws(() => render(props({ nriDirectory })), /nriDirectory/, nriDirectory);
  }
});

test("an injector serves only its own namespace", () => {
  assert.doesNotThrow(() => render(props({ targetNamespace: "guests" })));
  assert.throws(() => render(props({ targetNamespace: "other-guests" })), /targetNamespace/);
  const [deployment] = render(props()).objects;
  const args: string[] = deployment.spec.template.spec.containers[0].args;
  assert.equal(args[args.indexOf("--namespace") + 1], deployment.metadata.namespace);
});

test("bindings come from props, in order, each once", () => {
  const [deployment] = render(props({ bindings: [{ pod: "b", container: "x" }, { pod: "a", container: "y" }] })).objects;
  const args: string[] = deployment.spec.template.spec.containers[0].args;
  assert.deepEqual(args.slice(args.indexOf("--binding")), ["--binding", "b=x", "--binding", "a=y"]);
  const refusals: [string, NriKeyInjectorProps["bindings"]][] = [
    ["none", []],
    ["twice", [{ pod: "a", container: "x" }, { pod: "a", container: "x" }]],
    ["pod name", [{ pod: "A", container: "x" }]],
    ["pod with =", [{ pod: "a=b", container: "x" }]],
    ["container name", [{ pod: "a", container: "x.y" }]],
  ];
  for (const [label, bindings] of refusals) assert.throws(() => render(props({ bindings })), /binding/, label);
});

test("plugin index, runtime handler, device and image are validated", () => {
  const refusals: [string, Partial<NriKeyInjectorProps>, RegExp][] = [
    ["one-digit index", { pluginIndex: "7" }, /pluginIndex/],
    ["three-digit index", { pluginIndex: "100" }, /pluginIndex/],
    ["numeric index", { pluginIndex: 40 as any }, /pluginIndex/],
    ["runtime handler", { runtimeHandler: "Kata QEMU" }, /runtimeHandler/],
    ["device major", { device: { major: 4096, minor: 1 } }, /device/],
    ["device minor", { device: { major: 10, minor: -1 } }, /device/],
    ["tagged image", { image: "registry.example.com/guests/key-injector:latest" }, /digestImage/],
    ["namespace", { namespace: "Guests" }, /namespace/],
    ["name", { name: "key_injector" }, /name/],
    ["node", { nodeName: "" }, /nodeName/],
    ["pull secret", { imagePullSecrets: ["Bad Name"] }, /imagePullSecrets/],
    ["sync wave", { syncWave: 1.5 }, /syncWave/],
    ["misspelt prop", { nriDir: "/run/nri" } as any, /unknown field nriDir/],
    ["binding field", { bindings: [{ pod: "a", container: "x", namespace: "other" }] } as any, /unknown field namespace/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(props(change)), error, label);
});

test("pod labels default to <namespace>-<name> and may be set", () => {
  const [deployment] = render(props({ podLabels: { "app.kubernetes.io/name": "key-injector" }, syncWave: -5 })).objects;
  assert.deepEqual(deployment.spec.selector.matchLabels, { "app.kubernetes.io/name": "key-injector" });
  assert.deepEqual(deployment.spec.template.metadata.labels, { "app.kubernetes.io/name": "key-injector" });
  assert.equal(deployment.metadata.annotations["argocd.argoproj.io/sync-wave"], "-5");
  assert.throws(() => render(props({ podLabels: {} })), /podLabels/);
});
