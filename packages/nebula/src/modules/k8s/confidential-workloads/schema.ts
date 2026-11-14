import { CONFIDENTIAL_GROUP } from "./types";
import { TRUSTEE_CHART, TRUSTEE_CHART_VERSION } from "./chart";
import { namePattern, pathPattern } from "./validation";

type Schema = Record<string, unknown>;
const str = (extra: Schema = {}): Schema => ({ type: "string", maxLength: 4096, ...extra });
const int = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}) });
const list = (items: Schema, maxItems = 64, minItems = 0): Schema => ({ type: "array", items, maxItems, minItems });
const labels = { type: "object", maxProperties: 64, additionalProperties: str() };
const memoryPattern = "^[1-9][0-9]*(Mi|Gi)$";
const cpuPattern = "^([1-9][0-9]*m|(0|[1-9][0-9]*)([.][0-9]{1,3})?)$";
const memory = str({ pattern: memoryPattern, maxLength: 16, "x-kubernetes-validations": [
  { rule: "quantity(self).compareTo(quantity('1048576Gi')) <= 0", message: "Memory must not exceed 2^50 bytes" },
] });
const resourceMap = { type: "object", maxProperties: 2, additionalProperties: str({ maxLength: 16 }),
  "x-kubernetes-validations": [
    { rule: "self.all(k, k == 'cpu' || k == 'memory')", message: "Only CPU and memory resources are supported" },
    { rule: `self.all(k, k != 'cpu' || (self[k].matches('${cpuPattern}') && quantity(self[k]).compareTo(quantity('1m')) >= 0 && quantity(self[k]).compareTo(quantity('32')) <= 0))`, message: "CPU must be between 1 and 32000 millicores" },
    { rule: `self.all(k, k != 'memory' || (self[k].matches('${memoryPattern}') && quantity(self[k]).compareTo(quantity('1048576Gi')) <= 0))`, message: "Memory must be positive Mi/Gi and at most 2^50 bytes" },
  ] };
const containerResources = { ...obj({ requests: resourceMap, limits: resourceMap }), "x-kubernetes-validations": [
  { rule: "self.requests.all(k, !(k in self.limits) || quantity(self.requests[k]).compareTo(quantity(self.limits[k])) <= 0)", message: "Resource requests must not exceed their limits" },
] };
const environment = { ...labels, "x-kubernetes-validations": [
  { rule: "self.all(k, k.matches('^[A-Za-z_][A-Za-z0-9_]*$') && k != 'HOSTNAME' && !k.startsWith('TRUSTEE_'))", message: "Environment names must be valid and must not override reserved runtime names" },
] };
let escapedNetwork = "self";
for (const escape of "dDsSwW") escapedNetwork += `.replace(${JSON.stringify("\\" + escape)}, '')`;
const networkPattern = str({ maxLength: 256, "x-kubernetes-validations": [
  { rule: "self.startsWith('^') && self.endsWith('$') && self.matches('^[ -~]+$')", message: "CNI patterns must be anchored ASCII expressions" },
  { rule: "!self.replace('(?:', '').contains('(?')", message: "CNI patterns do not support lookarounds or inline flags" },
  { rule: `!${escapedNetwork}.matches(${JSON.stringify("\\\\[A-Za-z0-9]")})`, message: "CNI patterns do not support backreferences or unsupported escapes" },
  { rule: "''.matches(self) || !''.matches(self)", message: "CNI patterns must compile as bounded RE2 expressions" },
] });
const name = str({ pattern: namePattern, maxLength: 40 });
const imagePattern = "^.+@sha256:[a-f0-9]{64}$";
const publishedImagePattern = "^[A-Za-z0-9][A-Za-z0-9.:-]*/[a-z0-9][a-z0-9/._-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$";
const image = str({ pattern: imagePattern });
const workloadImage = str({ oneOf: [{ pattern: imagePattern }, { pattern: publishedImagePattern }] });
const resource = list(str({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$", maxLength: 128 }), 3, 3);
const runtime = obj({
  memoryMiB: int(2048, 65536), vcpus: int(1, 32), createContainerTimeoutSeconds: int(1, 3600),
  k8sDistribution: str({ enum: ["k0s", "kubernetes"] }), ociVersion: str({ enum: ["1.1.0", "1.2.0", "1.3.0"] }),
}, []);
export const guestIdentitySchema = obj({
  measurement: str({ pattern: "^[a-f0-9]{96}$" }), chipId: str({ pattern: "^[a-f0-9]{128}$" }),
  minimumReportedTcb: obj({ bootloader: int(0, 255), tee: int(0, 255), snp: int(0, 255), microcode: int(0, 255) }),
});
export const storageSpecSchema: Schema = {
  ...obj({
    type: str({ enum: ["Memory", "EncryptedBlock"] }),
    sizeLimit: memory,
    claimName: name, sizeBytes: int(64 * 1024 * 1024, 2 ** 50), keyResource: resource,
    initialization: str({ enum: ["Never", "IfEmpty"] }), retention: str({ enum: ["Retain"] }),
  }, ["type"]),
  "x-kubernetes-validations": [
    { rule: "self.type == 'Memory' ? has(self.sizeLimit) && !has(self.claimName) && !has(self.keyResource) && !has(self.sizeBytes) && !has(self.initialization) && !has(self.retention) : has(self.claimName) && has(self.sizeBytes) && has(self.keyResource) && has(self.initialization) && has(self.retention) && !has(self.sizeLimit)",
      message: "Specify memory size or a complete encrypted block declaration" },
    { rule: "!has(self.sizeBytes) || self.sizeBytes % 512 == 0", message: "Block size must be a multiple of 512" },
    { rule: "self == oldSelf", message: "Storage declarations are immutable; use a new resource for a changed binding" },
  ],
};
export const workloadSpecSchema = obj({
  profile: name, ownerPublicKeyPem: str({ maxLength: 2048 }),
  ownerClaimSha256: str({ pattern: "^[a-f0-9]{64}$", maxLength: 64 }),
  accessLink: obj({ url: str({ maxLength: 1024, pattern: "^(https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?|http://127[.]0[.]0[.]1(:[0-9]+)?)/$" }),
    browser: obj({ invitationEndpoint: str({ pattern: "^http://[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*[.]svc:8089/invitation$" }), workloadEndpoint: str(), loaderUrl: str(), ownerEndpoint: str(), manualTls: { type: "boolean", enum: [true] } }, ["invitationEndpoint", "workloadEndpoint", "loaderUrl"]),
    secretName: name, ownerPort: int(1, 65535), vcekCertificate: str({ maxLength: 32768, pattern: "^-----BEGIN CERTIFICATE-----\\n" }) },
    ["url", "secretName", "ownerPort"]),
  browserOwner: { type: "boolean", enum: [true] },
  guest: guestIdentitySchema, nodeSelector: labels,
  network: obj({ ipv4AddressPattern: networkPattern, ipv6AddressPattern: networkPattern }),
  trustee: obj({ chart: str({ enum: [TRUSTEE_CHART] }), version: str({ enum: [TRUSTEE_CHART_VERSION] }),
    kbsImage: image, tngImage: image, gatewayImage: image },
    ["chart", "kbsImage", "tngImage"]),
  agentImage: image, storageImage: image,
  containers: list({ ...obj({
    name, image: workloadImage, imageKeyResource: resource,
    command: list(str(), 64, 1), commandFromImage: { type: "boolean", enum: [true] }, args: list(str(), 128), env: environment,
    uid: int(11000, 65534), gid: int(11000, 65534),
    mounts: list(obj({ storage: name, path: str({ pattern: pathPattern, maxLength: 256 }) }), 8),
    applicationResources: list(resource, 64),
    ports: list(obj({ name: str({ maxLength: 15 }), port: int(1024, 65535) }), 16),
    resources: containerResources,
  }, ["name", "image", "uid", "gid"]),
    "x-kubernetes-validations": [{ rule: "self.image.matches('.*@sha256:[a-f0-9]{64}$') || has(self.imageKeyResource)",
      message: "A publication tag requires an image key resource" },
    { rule: "!self.name.startsWith('nebula-') && self.name != 'agent' && self.name != 'kbs' && self.name != 'tng' && self.name != 'coco-volume-marker'", message: "Application names cannot shadow runtime helpers" },
    { rule: "!has(self.ports) || self.ports.all(p, self.ports.filter(q, p.name == q.name).size() == 1 && self.ports.filter(q, p.port == q.port).size() == 1)", message: "Application port names and numbers must be unique" },
    { rule: "!has(self.command) || !has(self.commandFromImage)", message: "Choose an explicit command or the image entrypoint" },
    { rule: "has(self.command) || !has(self.args)", message: "Image entrypoint includes the image Cmd; args require an explicit command" }] }, 8, 1),
  storage: list(obj({ name, resource: name }), 8),
  resources: list(resource, 64, 1),
  registryMirrors: list(obj({ prefix: str(), location: str(), insecure: { type: "boolean" } }), 16),
  runtime,
}, ["profile", "guest", "nodeSelector", "network", "trustee", "containers", "resources"]);
(workloadSpecSchema as Schema)["x-kubernetes-validations"] = [
  { rule: "self.containers.all(c, self.containers.filter(other, other.name == c.name).size() == 1 && self.containers.filter(other, other.uid == c.uid).size() == 1 && self.containers.filter(other, other.gid == c.gid).size() == 1)", message: "Container names and application identities must be unique" },
  { rule: "self.containers.all(c, !has(c.ports) || c.ports.all(p, self.containers.all(other, c.name == other.name || !has(other.ports) || other.ports.all(q, p.name != q.name && p.port != q.port))))", message: "Ports must be unique across all application containers" },
  { rule: "!has(self.storage) || self.storage.all(b, self.storage.filter(other, b.name == other.name).size() == 1)", message: "Storage binding names must be unique" },
  { rule: "has(self.agentImage) || (has(self.storageImage) && has(self.trustee.gatewayImage))", message: "Specify the measured agent image" },
  { rule: "(has(self.ownerPublicKeyPem) ? 1 : 0) + (has(self.ownerClaimSha256) ? 1 : 0) + (has(self.accessLink) ? 1 : 0) == 1",
    message: "Choose an owner public key, one-use claim hash or generated access link" },
];

export function confidentialCrds() {
  return [
    ["ConfidentialWorkload", "confidentialworkloads", "cw", workloadSpecSchema],
    ["ConfidentialStorage", "confidentialstorages", "cs", storageSpecSchema],
  ].map(([kind, plural, short, spec]) => ({
    apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition",
    metadata: { name: `${plural}.${CONFIDENTIAL_GROUP}`,
      annotations: { "argocd.argoproj.io/sync-wave": "-3", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" } },
    spec: { group: CONFIDENTIAL_GROUP, scope: "Namespaced", conversion: { strategy: "None" },
      names: { kind, listKind: `${kind}List`, plural, singular: String(kind).toLowerCase(), shortNames: [short] },
      versions: [{ name: "v1alpha1", served: true, storage: true,
        subresources: { status: {} },
        additionalPrinterColumns: [{ name: "Phase", type: "string", jsonPath: ".status.phase" }],
        schema: { openAPIV3Schema: obj({ apiVersion: str(), kind: str(), metadata: { type: "object" },
          spec: spec as Schema,
          status: obj({ observedGeneration: int(0, Number.MAX_SAFE_INTEGER), phase: str(), reason: str({ maxLength: 128 }), message: str({ maxLength: 1024 }),
            podName: str(), podUid: str(), specSha256: str(), initDataSha256: str(),
            desiredSpecSha256: str({ pattern: "^[a-f0-9]{64}$" }),
            resolvedImageDigests: { type: "object", maxProperties: 32, additionalProperties: str({ pattern: "^sha256:[a-f0-9]{64}$" }) },
            accessTokenSha256: str({ pattern: "^[a-f0-9]{64}$" }), accessSecretName: name }, []),
        }, ["spec"]) },
      }],
    },
  }));
}
