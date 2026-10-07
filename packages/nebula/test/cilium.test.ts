import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Testing, Yaml } from "cdk8s";
import { parseAllDocuments } from "yaml";
import { Cilium, type CiliumConfig } from "../src/modules/k8s/cilium";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { SshK0sProvider } from "../src/modules/infra/k0s/ssh-provider";

// Capture what the real construct gives Helm, including the final merge. A
// refusal must happen before invoking Helm, so invalid input needs no network.
function withHelm<T>(run: (render: (config?: CiliumConfig) => any, called: () => boolean) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cilium-helm-"));
  const output = join(dir, "values.yaml");
  writeFileSync(join(dir, "helm"), [
    "#!/bin/sh",
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = -f ]; then cp "$arg" "$CILIUM_VALUES_OUT"; fi',
    '  previous="$arg"',
    "done",
  ].join("\n"), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CILIUM_VALUES_OUT: process.env.CILIUM_VALUES_OUT };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.CILIUM_VALUES_OUT = output;
  try {
    return run(config => {
      new Cilium(Testing.chart(), "cilium", config);
      return Yaml.load(output)[0];
    }, () => existsSync(output));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("default public mesh requires both pod CIDRs and on-link IPv6 transport", () => {
  withHelm(render => {
    const values = render();
    assert.deepEqual(values.ipv4, { enabled: true });
    assert.deepEqual(values.ipv6, { enabled: true });
    assert.deepEqual(values.ipam, { mode: "kubernetes" });
    assert.deepEqual(values.k8s, { requireIPv4PodCIDR: true, requireIPv6PodCIDR: true });
    assert.equal(values.underlayProtocol, "ipv6");
    assert.equal(values.preferIpv6, true);
    assert.equal(values.MTU, 1400);
    assert.equal(values.routingMode, "tunnel");
    assert.equal(values.encryption.type, "wireguard");
    assert.equal(values.encryption.enabled, true);
    assert.equal(values.cni.install, true);
    assert.equal(values.cni.exclusive, true);
    assert.equal(values.daemon.configSources, "config-map:cilium-config");
  });
});

test("explicit private reachability keeps IPv4 transport and NIC MTU, with dual-stack pods", () => {
  withHelm(render => {
    const values = render({ nodeConnectivity: "private", underlayProtocol: "ipv4" });
    assert.equal(values.ipv4.enabled, true);
    assert.equal(values.ipv6.enabled, true);
    assert.equal(values.k8s.requireIPv6PodCIDR, true);
    assert.equal(values.underlayProtocol, "ipv4");
    assert.equal(values.MTU, undefined);
    assert.equal(render({ nodeConnectivity: "private", mtu: 9001 }).MTU, 9001);
  });
});

test("explicit private IPv4 profile changes only the enabled family and CIDR wait", () => {
  withHelm(render => {
    const dualStack = render({ nodeConnectivity: "private" });
    const ipv4 = render({ nodeConnectivity: "private", podAddressFamilies: "ipv4" });
    assert.deepEqual(ipv4, {
      ...dualStack,
      ipv6: { enabled: false },
      k8s: { requireIPv4PodCIDR: true, requireIPv6PodCIDR: false },
    });
    assert.equal(ipv4.underlayProtocol, "ipv4");
    assert.equal(ipv4.preferIpv6, false);
    assert.equal(ipv4.daemon.configSources, "config-map:cilium-config");
  });
});

test("existing explicit dual-stack configuration and unrelated overrides still render", () => {
  withHelm(render => {
    const values = render({
      ipv6: true, underlayProtocol: "ipv6", mtu: 1400,
      hubble: true, agentServiceMonitor: false, operatorServiceMonitor: false,
      values: {
        preferIpv6: true, k8s: { apiServerURLs: "https://api.example.test:6443" },
        operator: { replicas: 1 }, extraConfig: { debug: "true" },
        extraArgs: ["--debug=true"], extraEnv: [{ name: "TZ", value: "UTC" }],
      },
    });
    assert.equal(values.hubble.tls.auto.method, "cronJob");
    assert.equal(values.prometheus.serviceMonitor.enabled, false);
    assert.equal(values.operator.replicas, 1);
    assert.equal(values.k8s.requireIPv4PodCIDR, true);
    assert.equal(values.k8s.requireIPv6PodCIDR, true);
    assert.equal(values.k8s.apiServerURLs, "https://api.example.test:6443");
    assert.equal(values.extraConfig.debug, "true");
    assert.deepEqual(values.extraArgs, ["--debug=true"]);
    assert.deepEqual(values.extraEnv, [{ name: "TZ", value: "UTC" }]);
    assert.equal(render({ values: { MTU: 1280 } }).MTU, 1280);
  });
});

const nodeIpv6Overrides = { nodes: [{ name: "retained-worker-1", nodeName: "worker-1", ipv6: "2001:db8:1::2" }] };
test("declared IPv6 inventory enables only selector-scoped IPv6 overrides and preserves caller annotations", () => {
  withHelm(render => {
    const values = render({ nodeIpv6Overrides, values: { podAnnotations: { "example.test/settings": "unchanged" } } });
    assert.deepEqual(values.daemon, {
      configSources: "config-map:cilium-config,cilium-node-config:kube-system", allowedConfigOverrides: "ipv6-node",
    });
    assert.equal(values.podAnnotations["example.test/settings"], "unchanged");
    assert.match(values.podAnnotations["nebula.sh/cilium-node-ipv6-checksum"], /^[a-f0-9]{64}$/);
    assert.equal(values.k8s.requireIPv6PodCIDR, true);
    assert.equal(values.underlayProtocol, "ipv6");
  });
});

for (const [name, values] of [
  ["named source bypassing selectors", { daemon: { configSources: "config-map:cilium-config,cilium-node-config:kube-system/retained-worker-1" } }],
  ["arbitrary override keys", { daemon: { allowedConfigOverrides: "ipv6-node,enable-ipv6" } }],
  ["removed override allowlist", { daemon: { allowedConfigOverrides: null } }],
  ["environment source replacement", { extraEnv: [{ name: "CILIUM_CONFIG_SOURCES", value: "[]" }] }],
] as const) test(`reject inventory ${name} before Helm`, () => {
  withHelm((render, called) => {
    assert.throws(() => render({ nodeIpv6Overrides, values }), /daemon|extraEnv/);
    assert.equal(called(), false);
  });
});

const invalid: [string, unknown, RegExp][] = [
  ["typed single-stack", { ipv6: false }, /ipv6 cannot be disabled/],
  ["unknown pod families", { podAddressFamilies: "ipv6" }, /podAddressFamilies/],
  ["IPv4 without private topology", { podAddressFamilies: "ipv4" }, /explicit nodeConnectivity/],
  ["public IPv4 pods", { nodeConnectivity: "public", podAddressFamilies: "ipv4" }, /explicit nodeConnectivity/],
  ["invalid topology", { nodeConnectivity: "auto" }, /nodeConnectivity/],
  ["public IPv4", { underlayProtocol: "ipv4" }, /public node connectivity requires/],
  ["auto transport", { underlayProtocol: "auto" }, /underlayProtocol/],
  ["raw IPv4 disabled", { values: { ipv4: { enabled: false } } }, /ipv4.enabled/],
  ["raw IPv6 disabled", { values: { ipv6: { enabled: false } } }, /ipv6.enabled/],
  ["raw IPv6 string", { values: { ipv6: { enabled: "false" } } }, /ipv6.enabled/],
  ["null IPv6 map", { values: { ipv6: null } }, /ipv6/],
  ["array IPv6 map", { values: { ipv6: [] } }, /ipv6/],
  ["alternate IPAM", { values: { ipam: { mode: "cluster-pool" } } }, /ipam.mode/],
  ["missing v4 CIDR allowed", { values: { k8s: { requireIPv4PodCIDR: false } } }, /requireIPv4PodCIDR/],
  ["missing v6 CIDR allowed", { values: { k8s: { requireIPv6PodCIDR: false } } }, /requireIPv6PodCIDR/],
  ["null CIDR requirement", { values: { k8s: { requireIPv6PodCIDR: null } } }, /requireIPv6PodCIDR/],
  ["raw public IPv4", { values: { underlayProtocol: "ipv4" } }, /public node connectivity requires/],
  ["raw auto transport", { values: { underlayProtocol: "auto" } }, /underlayProtocol/],
  ["native routing", { values: { routingMode: "native" } }, /routingMode/],
  ["raw jumbo MTU", { values: { MTU: 9001 } }, /MTU/],
  ["typed jumbo MTU", { mtu: 9001 }, /MTU/],
  ["auto MTU", { values: { MTU: 0 } }, /MTU/],
  ["negative MTU", { mtu: -1 }, /mtu/],
  ["sub-minimum MTU", { values: { MTU: 1200 } }, /MTU/],
  ["fractional MTU", { mtu: 1399.5 }, /MTU/],
  ["NaN MTU", { mtu: NaN }, /MTU/],
  ["infinite MTU", { mtu: Infinity }, /MTU/],
  ["string MTU", { values: { MTU: "1400" } }, /MTU/],
  ["null MTU", { values: { MTU: null } }, /MTU/],
  ["private too-small MTU", { nodeConnectivity: "private", values: { MTU: 1200 } }, /MTU/],
  ["custom CNI", { values: { cni: { customConf: true } } }, /cni.customConf/],
  ["CNI chaining", { values: { cni: { chainingMode: "aws-cni" } } }, /cni.chainingMode/],
  ["implicit CNI chaining", { values: { cni: { chainingTarget: "another-cni" } } }, /cni.chainingTarget/],
  ["CNI config map", { values: { cni: { configMap: "custom-cni" } } }, /cni.configMap/],
  ["CNI config file", { values: { cni: { readCniConf: "/tmp/custom.conf" } } }, /cni.readCniConf/],
  ["CNI not installed", { values: { cni: { install: false } } }, /cni.install/],
  ["other CNI permitted", { values: { cni: { exclusive: false } } }, /cni.exclusive/],
  ["node config override", { values: { daemon: { configSources: "config-map:cilium-config,cilium-node-config" } } }, /daemon.configSources/],
  ["agent disabled", { values: { agent: false } }, /agent/],
  ["sleeping agent", { values: { sleepAfterInit: true } }, /sleepAfterInit/],
  ["stale running config", { values: { rollOutCiliumPods: false } }, /rollOutCiliumPods/],
  ["ConfigMap duplicate", { values: { extraConfig: { "enable-ipv6": "false" } } }, /extraConfig.enable-ipv6/],
  ["CIDR flag bypass", { values: { extraConfig: { "k8s-require-ipv6-pod-cidr": "false" } } }, /extraConfig/],
  ["public node identity bypass", { values: { extraConfig: { "ipv4-node": "192.0.2.1" } } }, /extraConfig/],
  ["argument bypass", { values: { extraArgs: ["--enable-ipv6=false"] } }, /extraArgs/],
  ["split argument bypass", { values: { extraArgs: ["--underlay-protocol", "ipv4"] } }, /extraArgs/],
  ["config-directory bypass", { values: { extraArgs: ["--config-dir=/tmp/other"] } }, /extraArgs/],
  ["environment bypass", { values: { extraEnv: [{ name: "CILIUM_ENABLE_IPV6", value: "false" }] } }, /extraEnv/],
  ["indirect environment bypass", { values: { extraEnv: [{ name: "CILIUM_IPAM", valueFrom: { configMapKeyRef: { name: "overrides", key: "ipam" } } }] } }, /extraEnv/],
];
for (const [name, config, message] of invalid) {
  test(`reject ${name} before Helm`, () => {
    withHelm((render, called) => {
      assert.throws(() => render(config as CiliumConfig), message);
      assert.equal(called(), false);
    });
  });
}

for (const [name, config, message] of [
  ["legacy IPv6 enable flag", { ipv6: true }, /cannot enable ipv6/],
  ["IPv6 inventory", { nodeIpv6Overrides }, /nodeIpv6Overrides/],
  ["IPv6 transport", { underlayProtocol: "ipv6" }, /underlayProtocol/],
  ["raw IPv6 transport", { values: { underlayProtocol: "ipv6" } }, /underlayProtocol/],
  ["raw IPv6 enabled", { values: { ipv6: { enabled: true } } }, /ipv6.enabled/],
  ["raw IPv6 CIDR wait", { values: { k8s: { requireIPv6PodCIDR: true } } }, /requireIPv6PodCIDR/],
  ["raw IPv4 disabled", { values: { ipv4: { enabled: false } } }, /ipv4.enabled/],
  ["raw IPv4 CIDR wait disabled", { values: { k8s: { requireIPv4PodCIDR: false } } }, /requireIPv4PodCIDR/],
  ["prefer IPv6", { values: { preferIpv6: true } }, /preferIpv6/],
  ["alternate IPAM", { values: { ipam: { mode: "cluster-pool" } } }, /ipam.mode/],
  ["node source override", { values: { daemon: { configSources: "cilium-node-config" } } }, /daemon.configSources/],
  ["ConfigMap bypass", { values: { extraConfig: { "enable-ipv6": "true" } } }, /extraConfig/],
  ["argument bypass", { values: { extraArgs: ["--enable-ipv6=true"] } }, /extraArgs/],
  ["environment bypass", { values: { extraEnv: [{ name: "CILIUM_ENABLE_IPV6", value: "true" }] } }, /extraEnv/],
] as const) test(`reject private IPv4 ${name} before Helm`, () => {
  withHelm((render, called) => {
    assert.throws(() => render({ nodeConnectivity: "private", podAddressFamilies: "ipv4", ...config }), message);
    assert.equal(called(), false);
  });
});

test("hosted cluster composition supplies both pod and service ranges", () => {
  const chart = Testing.chart();
  new K0smotronCluster(chart, "example", {
    name: "example", provider: new SshK0sProvider(), networkProvider: "custom",
    podCidr: "192.0.2.0/24", serviceCidr: "198.51.100.0/24",
    dualStack: { ipv6PodCidr: "2001:db8:100::/56", ipv6ServiceCidr: "2001:db8:200::/112" },
  });
  const cp = Testing.synth(chart).find(r => r.kind === "K0smotronControlPlane")!;
  const network = cp.spec.k0sConfig.spec.network;
  assert.equal(network.provider, "custom");
  assert.equal(network.podCIDR, "192.0.2.0/24");
  assert.equal(network.serviceCIDR, "198.51.100.0/24");
  assert.deepEqual(network.dualStack, { enabled: true, IPv6podCIDR: "2001:db8:100::/56", IPv6serviceCIDR: "2001:db8:200::/112" });
});

// Optional qualification against the actual pinned chart, without making unit
// tests depend on Helm or the internet. Download cilium-1.20.0.tgz, then set
// CILIUM_TEST_CHART to its absolute path (documented in the module README).
test("pinned Helm chart emits enforced agent settings", { skip: !process.env.CILIUM_TEST_CHART }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cilium-chart-"));
  try {
    for (const config of [{}, { nodeConnectivity: "private" as const }]) {
      const values = withHelm(render => render(config));
      const path = join(dir, "values.json");
      writeFileSync(path, JSON.stringify(values));
      const manifest = execFileSync("helm", ["template", "cilium", process.env.CILIUM_TEST_CHART!, "--namespace", "kube-system", "-f", path], { encoding: "utf8" });
      const objects = parseAllDocuments(manifest).map(doc => {
        assert.deepEqual(doc.errors, []);
        return doc.toJSON();
      });
      const data = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "cilium-config").data;
      for (const key of ["enable-ipv4", "enable-ipv6", "k8s-require-ipv4-pod-cidr", "k8s-require-ipv6-pod-cidr"]) assert.equal(data[key], "true", key);
      assert.equal(data.ipam, "kubernetes");
      assert.equal(data["underlay-protocol"], config.nodeConnectivity === "private" ? "ipv4" : "ipv6");
      assert.equal(data["routing-mode"], "tunnel");
      const template = objects.find(o => o.kind === "DaemonSet" && o.metadata.name === "cilium").spec.template;
      assert.match(template.metadata.annotations["cilium.io/cilium-configmap-checksum"], /^[a-f0-9]{64}$/);
      const pod = template.spec;
      assert.equal(pod.hostNetwork, true);
      assert.ok(pod.volumes.some((v: any) => v.configMap?.name === "cilium-config"));
      assert.ok(!pod.initContainers.some((c: any) => c.name === "config"), "do not merge per-node overrides");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned Helm chart limits build-config to selector-scoped ipv6-node inventory", { skip: !process.env.CILIUM_TEST_CHART }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cilium-inventory-chart-"));
  try {
    const values = withHelm(render => render({ nodeIpv6Overrides }));
    const path = join(dir, "values.json");
    writeFileSync(path, JSON.stringify(values));
    const manifest = execFileSync("helm", ["template", "cilium", process.env.CILIUM_TEST_CHART!, "--namespace", "kube-system", "-f", path], { encoding: "utf8" });
    const objects = parseAllDocuments(manifest).map(doc => { assert.deepEqual(doc.errors, []); return doc.toJSON(); });
    const template = objects.find(o => o.kind === "DaemonSet" && o.metadata.name === "cilium").spec.template;
    assert.equal(template.metadata.annotations["nebula.sh/cilium-node-ipv6-checksum"], values.podAnnotations["nebula.sh/cilium-node-ipv6-checksum"]);
    assert.deepEqual(template.spec.initContainers.find((c: any) => c.name === "config").command, [
      "cilium-dbg", "build-config", "--source=config-map:cilium-config,cilium-node-config:kube-system", "--allow-config-keys=ipv6-node",
    ]);
    assert.deepEqual(template.spec.volumes.find((v: any) => v.name === "tmp"), { name: "tmp", emptyDir: {} });
    assert.ok(template.spec.containers[0].volumeMounts.some((v: any) => v.name === "tmp" && v.mountPath === "/tmp"));
    const data = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "cilium-config").data;
    assert.equal(data["enable-ipv6"], "true");
    assert.equal(data["k8s-require-ipv6-pod-cidr"], "true");
    assert.equal(data["underlay-protocol"], "ipv6");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pinned Helm chart preserves private IPv4 without an IPv6 CIDR requirement", { skip: !process.env.CILIUM_TEST_CHART }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cilium-ipv4-chart-"));
  try {
    const values = withHelm(render => render({ nodeConnectivity: "private", podAddressFamilies: "ipv4" }));
    const path = join(dir, "values.json");
    writeFileSync(path, JSON.stringify(values));
    const manifest = execFileSync("helm", ["template", "cilium", process.env.CILIUM_TEST_CHART!, "--namespace", "kube-system", "-f", path], { encoding: "utf8" });
    const objects = parseAllDocuments(manifest).map(doc => { assert.deepEqual(doc.errors, []); return doc.toJSON(); });
    const data = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "cilium-config").data;
    assert.equal(data["enable-ipv4"], "true");
    assert.equal(data["enable-ipv6"], "false");
    assert.equal(data["k8s-require-ipv4-pod-cidr"], "true");
    assert.equal(data["k8s-require-ipv6-pod-cidr"], "false");
    assert.equal(data.ipam, "kubernetes");
    assert.equal(data["underlay-protocol"], "ipv4");
    assert.equal(data["tunnel-protocol"], "vxlan");
    assert.equal(data["prefer-ipv6"], undefined);
    assert.equal(data.mtu, undefined);
    const template = objects.find(o => o.kind === "DaemonSet" && o.metadata.name === "cilium").spec.template;
    assert.match(template.metadata.annotations["cilium.io/cilium-configmap-checksum"], /^[a-f0-9]{64}$/);
    assert.ok(!template.spec.initContainers.some((c: any) => c.name === "config"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
