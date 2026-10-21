import { CONFIDENTIAL_GROUP } from "./types";
import { namePattern, pathPattern } from "./validation";

type Schema = Record<string, unknown>;
const str = (extra: Schema = {}): Schema => ({ type: "string", maxLength: 4096, ...extra });
const int = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}) });
const list = (items: Schema, maxItems = 64, minItems = 0): Schema => ({ type: "array", items, maxItems, minItems });
const labels = { type: "object", maxProperties: 64, additionalProperties: str() };
const name = str({ pattern: namePattern, maxLength: 40 });
const image = str({ pattern: "^.+@sha256:[a-f0-9]{64}$" });
const resource = list(str({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$", maxLength: 128 }), 3, 3);
const runtime = obj({
  memoryMiB: int(2048, 65536), vcpus: int(1, 32),
  k8sDistribution: str({ enum: ["k0s", "kubernetes"] }), ociVersion: str({ enum: ["1.1.0", "1.2.0", "1.3.0"] }),
}, []);
export const guestIdentitySchema = obj({
  measurement: str({ pattern: "^[a-f0-9]{96}$" }), chipId: str({ pattern: "^[a-f0-9]{128}$" }),
  minimumReportedTcb: obj({ bootloader: int(0, 255), tee: int(0, 255), snp: int(0, 255), microcode: int(0, 255) }),
});
export const storageSpecSchema: Schema = {
  ...obj({
    type: str({ enum: ["Memory", "EncryptedBlock"] }),
    sizeLimit: str({ pattern: "^[1-9][0-9]*(Mi|Gi)$", maxLength: 16 }),
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
  guest: guestIdentitySchema, nodeSelector: labels,
  network: obj({ ipv4AddressPattern: str({ maxLength: 256 }), ipv6AddressPattern: str({ maxLength: 256 }) }),
  trustee: obj({ chart: str(), repository: str(), version: str(), kbsImage: image, tngImage: image, gatewayImage: image },
    ["chart", "kbsImage", "tngImage", "gatewayImage"]),
  storageImage: image,
  containers: list(obj({
    name, image, command: list(str(), 64, 1), args: list(str(), 128), env: labels,
    uid: int(11000, 65534), gid: int(11000, 65534),
    mounts: list(obj({ storage: name, path: str({ pattern: pathPattern }) }), 8),
    applicationResources: list(resource, 64),
    ports: list(obj({ name: str({ maxLength: 15 }), port: int(1024, 65535) }), 16),
    resources: obj({ requests: labels, limits: labels }),
  }, ["name", "image", "command", "uid", "gid"]), 8, 1),
  storage: list(obj({ name, resource: name }), 8),
  resources: list(resource, 64, 1),
  registryMirrors: list(obj({ prefix: str(), location: str(), insecure: { type: "boolean" } }), 16),
  runtime,
}, ["profile", "ownerPublicKeyPem", "guest", "nodeSelector", "network", "trustee", "storageImage", "containers", "resources"]);

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
          status: obj({ observedGeneration: int(0, Number.MAX_SAFE_INTEGER), phase: str(), message: str({ maxLength: 1024 }),
            podName: str(), podUid: str(), specSha256: str(), initDataSha256: str() }, []),
        }, ["spec"]) },
      }],
    },
  }));
}
