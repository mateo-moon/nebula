import { Construct } from "constructs";
import {
  IntOrString, KubeConfigMap, KubeDeployment, KubeNetworkPolicy, KubeService, Quantity,
} from "cdk8s-plus-33/lib/imports/k8s";
import { readConfidentialGuestAsset } from "./assets";
import { sha256Hex } from "./canonical";
import {
  command, dnsLabel, dnsSubdomain, fail, image, integer, isPlainObject, knownFields, labelDomain, labels, pullSecrets, serviceName,
  waveAnnotation,
} from "./validate";

/**
 * Which guests the broker releases the pull credentials to, by the SHA-256
 * of their measured init-data (the value SEV-SNP reports as HOST_DATA):
 * exactly one (`equals`) or any of a list (`in`, rendered in the given order).
 *
 * Init-data is a launch parameter the host chooses, so on its own it does
 * not identify the guest software: any non-debug guest launched with an
 * admitted init-data hash receives the credentials. A deployment should pin
 * the launch measurements of its releases ({@link MeasurementAdmission}).
 */
export type InitDataAdmission =
  | { readonly form: "equals"; readonly value: string }
  | { readonly form: "in"; readonly values: readonly string[] };

/**
 * Which guests the broker releases the pull credentials to, by their SEV-SNP
 * launch measurement (the 48-byte launch digest, 96 lowercase hex characters
 * as the attestation token reports it): exactly one (`equals`) or any of a
 * list (`in`, rendered in the given order).
 */
export type MeasurementAdmission =
  | { readonly form: "equals"; readonly value: string }
  | { readonly form: "in"; readonly values: readonly string[] };

/** A KBS resource path: repository, type and tag. */
export type KbsResourcePath = readonly [repository: string, type: string, tag: string];

export interface AttestedPullBrokerProps {
  readonly namespace: string;
  /** Name of the Service and Deployment guests reach. */
  readonly name: string;
  /** ConfigMap holding the KBS configuration and resource policy. */
  readonly configMapName: string;
  /**
   * NetworkPolicy names: `ingressBoundary` denies all ingress to every Pod
   * of the namespace; `fromGuests` admits the guests to the broker port.
   */
  readonly networkPolicyNames: { readonly ingressBoundary: string; readonly fromGuests: string };
  /** Broker Pod labels and the Service selector. */
  readonly podLabels: Readonly<Record<string, string>>;
  /** Labels of the guest Pods allowed to reach the broker. */
  readonly guestSelector: Readonly<Record<string, string>>;
  readonly nodeName: string;
  /** Digest-pinned KBS image; it runs `/usr/local/bin/kbs --config-file /configuration/config.toml`. */
  readonly brokerImage: string;
  /**
   * Where the broker's token-signing issuer comes from. Omitted, the caller's
   * init (`initImage`, `initCommand`) prepares `/state` from the pull Secret
   * mounted at `/registry`. `"ephemeral"`: the broker image itself mints a
   * P-256 CA issuer with its openssl CLI into `/state/issuer` (`key.pem`,
   * `cert.pem`) before KBS starts, keeps a matching unexpired pair across
   * restarts of the Pod's containers, and fails closed without one. The key
   * lives only in the Pod's memory-backed state and dies with the Pod. It
   * takes the read-only policy and needs `pullSecret.exposeAsResource`; the
   * init sees neither the credential nor the policy.
   */
  readonly issuer?: "ephemeral";
  /** Digest-pinned image of the init container that prepares `/state` from the pull Secret mounted at `/registry`. Omitted with the ephemeral issuer. */
  readonly initImage?: string;
  readonly initCommand?: readonly string[];
  /**
   * Mount the resource policy read-only where KBS reads it
   * (`/state/kbs/resource-policy.rego`), from the ConfigMap, instead of
   * leaving it to the init. Default false; always on with the ephemeral issuer.
   */
  readonly policyReadOnly?: boolean;
  /**
   * KBS configuration. The broker's state is an in-memory `/state`
   * (keep issuer material and the resource store there) and the
   * configuration is mounted at `/configuration`; the listening port must
   * be `port`.
   */
  readonly configToml: string;
  /** The resource the credentials are served as, e.g. `["default", "registry", "pull"]`. */
  readonly resourcePath: KbsResourcePath;
  readonly initData: InitDataAdmission;
  /**
   * Launch measurements admitted besides the init-data. Without it every
   * non-debug guest launched with an admitted init-data hash receives the
   * credentials; pin the launch measurements of the deployment's releases.
   */
  readonly measurement?: MeasurementAdmission;
  /**
   * Secret with the registry credentials (`.dockerconfigjson`). It is always
   * mounted for the init container; with `exposeAsResource` it is also
   * mounted read-only into the broker's local resource store as the resource.
   */
  readonly pullSecret: { readonly name: string; readonly exposeAsResource: boolean };
  /** Domain of the `<labelDomain>/config-sha256` annotation that rolls the broker when policy or configuration change. */
  readonly labelDomain: string;
  readonly imagePullSecrets?: readonly string[];
  /** Broker port. Default 8080. */
  readonly port?: number;
  /** Argo CD sync waves. Defaults: config (policies, ConfigMap, Service) -2, broker (Deployment) -1. */
  readonly syncWaves?: { readonly config?: number; readonly broker?: number };
}

const WHERE = "AttestedPullBroker";
const PROPS_FIELDS = [
  "namespace", "name", "configMapName", "networkPolicyNames", "podLabels", "guestSelector", "nodeName", "brokerImage", "issuer", "initImage",
  "initCommand", "policyReadOnly", "configToml", "resourcePath", "initData", "measurement", "pullSecret", "labelDomain", "imagePullSecrets", "port", "syncWaves",
];
const HOST_DATA = /^[a-f0-9]{64}$/;
const MEASUREMENT = /^[a-f0-9]{96}$/;
const RESOURCE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function hostData(value: unknown): string {
  if (typeof value !== "string" || !HOST_DATA.test(value) || /^0+$/.test(value)) {
    fail(WHERE, `init-data hashes must be nonzero SHA-256 values in lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

function launchMeasurement(value: unknown): string {
  if (typeof value !== "string" || !MEASUREMENT.test(value) || /^0+$/.test(value)) {
    fail(WHERE, `launch measurements must be nonzero 48-byte SEV-SNP launch digests in lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

function validResourcePath(value: unknown): KbsResourcePath {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === "string" && RESOURCE_SEGMENT.test(part) && part !== "..")) {
    fail(WHERE, `resourcePath must be [repository, type, tag] of [A-Za-z0-9._-], got ${JSON.stringify(value)}`);
  }
  return value as unknown as KbsResourcePath;
}

/** One policy line admitting `claim` by `admitted` values: `== "one"` or `in ["any", ...]`. */
function admission(what: string, claim: string, value: unknown, admitted: (value: unknown) => string): string {
  if (!isPlainObject(value)) fail(WHERE, `${what} admission must be { form: "equals", value } or { form: "in", values }`);
  if (value.form === "equals" && Object.keys(value).sort().join() === "form,value") return `${claim} == "${admitted(value.value)}"`;
  if (value.form === "in" && Object.keys(value).sort().join() === "form,values" && Array.isArray(value.values) && value.values.length > 0) {
    return `${claim} in ${JSON.stringify(value.values.map(admitted))}`;
  }
  fail(WHERE, `${what} admission must be { form: "equals", value } or { form: "in", values: [at least one] }`);
}

/**
 * The KBS resource policy: release the resource only to SEV-SNP evidence
 * without the debug policy bit whose init-data hash is admitted and, when a
 * measurement admission is given, whose launch measurement is admitted too.
 * Init-data alone does not identify the guest software (see
 * {@link InitDataAdmission}); without a measurement the policy is as before.
 */
export function pullBrokerPolicy(resourcePath: KbsResourcePath, initData: InitDataAdmission, measurement?: MeasurementAdmission): string {
  const path = validResourcePath(resourcePath);
  const admitted = [admission("init-data", "ev.init_data", initData, hostData)];
  if (measurement !== undefined) admitted.push(admission("measurement", "ev.snp.measurement", measurement, launchMeasurement));
  return `package policy
default allow := false
allow if {
    data.plugin == "resource"
    data["resource-path"] == [${path.map(part => JSON.stringify(part)).join(", ")}]
    ev := input.submods.cpu0["ear.veraison.annotated-evidence"]
    ${admitted.join("\n    ")}
    ev.snp.policy_debug_allowed == false
}
`;
}

/**
 * An attestation-gated pull broker: an upstream Key Broker Service that
 * releases private registry credentials to a guest's image pull only when
 * the guest's attested init-data (and, when pinned, its launch measurement)
 * is admitted. Renders, in order: a
 * namespace-wide ingress deny, the guests-to-broker ingress rule, the
 * configuration (KBS config and resource policy), the Service and the broker
 * Deployment, whose Pod template carries the configuration hash so a policy
 * change rolls it.
 */
export class AttestedPullBroker extends Construct {
  /** The rendered resource policy. */
  public readonly policy: string;
  /** SHA-256 of policy and configuration, as annotated on the broker Pods. */
  public readonly configSha256: string;
  /** The resource URI guests request (`kbs:///<repository>/<type>/<tag>`). */
  public readonly resourceUri: string;
  private readonly host: string;
  private readonly port: number;

  constructor(scope: Construct, id: string, props: AttestedPullBrokerProps) {
    super(scope, id);
    knownFields(WHERE, "props", props, PROPS_FIELDS);
    const namespace = dnsLabel(WHERE, "namespace", props.namespace);
    const name = serviceName(WHERE, "name", props.name);
    const configMapName = dnsSubdomain(WHERE, "configMapName", props.configMapName);
    knownFields(WHERE, "networkPolicyNames", props.networkPolicyNames, ["ingressBoundary", "fromGuests"]);
    const boundaryName = dnsSubdomain(WHERE, "networkPolicyNames.ingressBoundary", props.networkPolicyNames.ingressBoundary);
    const fromGuestsName = dnsSubdomain(WHERE, "networkPolicyNames.fromGuests", props.networkPolicyNames.fromGuests);
    const podLabels = labels(WHERE, "podLabels", props.podLabels);
    const guestSelector = labels(WHERE, "guestSelector", props.guestSelector);
    const nodeName = dnsSubdomain(WHERE, "nodeName", props.nodeName);
    const brokerImage = image(WHERE, "brokerImage", props.brokerImage);
    if (props.issuer !== undefined && props.issuer !== "ephemeral") fail(WHERE, `issuer must be "ephemeral" when given, got ${JSON.stringify(props.issuer)}`);
    const ephemeral = props.issuer === "ephemeral";
    if (props.policyReadOnly !== undefined && typeof props.policyReadOnly !== "boolean") fail(WHERE, `policyReadOnly must be a boolean`);
    if (ephemeral && props.policyReadOnly === false) fail(WHERE, `the ephemeral issuer reads the policy only read-only; omit policyReadOnly or set it true`);
    const policyReadOnly = ephemeral || props.policyReadOnly === true;
    const hasInit = props.initImage !== undefined || props.initCommand !== undefined;
    if (ephemeral && hasInit) fail(WHERE, `initImage and initCommand must be omitted with the ephemeral issuer`);
    if (!ephemeral && (props.initImage === undefined || props.initCommand === undefined)) {
      fail(WHERE, `initImage and initCommand are required unless issuer is "ephemeral"`);
    }
    const initImage = ephemeral ? brokerImage : image(WHERE, "initImage", props.initImage);
    const initCommand = ephemeral ? ["/bin/sh", "-c", readConfidentialGuestAsset("pull-broker-issuer.sh")] : command(WHERE, "initCommand", props.initCommand);
    if (typeof props.configToml !== "string" || props.configToml.length === 0) fail(WHERE, `configToml is required`);
    const resourcePath = validResourcePath(props.resourcePath);
    const secret = knownFields(WHERE, "pullSecret", props.pullSecret, ["name", "exposeAsResource"]);
    if (typeof secret.exposeAsResource !== "boolean") {
      fail(WHERE, `pullSecret must be { name, exposeAsResource: boolean }`);
    }
    const secretName = dnsSubdomain(WHERE, "pullSecret.name", secret.name);
    if (ephemeral && !secret.exposeAsResource) {
      fail(WHERE, `the ephemeral issuer's init does not write the resource; set pullSecret.exposeAsResource`);
    }
    const domain = labelDomain(WHERE, "labelDomain", props.labelDomain);
    const imagePullSecrets = pullSecrets(WHERE, props.imagePullSecrets);
    const port = integer(WHERE, "port", props.port ?? 8080, 1, 65535);
    if (props.syncWaves !== undefined) knownFields(WHERE, "syncWaves", props.syncWaves, ["config", "broker"]);
    const configWave = waveAnnotation(WHERE, "syncWaves.config", props.syncWaves?.config ?? -2);
    const brokerWave = waveAnnotation(WHERE, "syncWaves.broker", props.syncWaves?.broker ?? -1);

    this.policy = pullBrokerPolicy(resourcePath, props.initData, props.measurement);
    this.configSha256 = sha256Hex(this.policy + props.configToml);
    this.resourceUri = `kbs:///${resourcePath.join("/")}`;
    this.host = `${name}.${namespace}.svc`;
    this.port = port;

    const metadata = (objectName: string, wave: Record<string, string>) => ({ name: objectName, namespace, annotations: { ...wave } });
    const restricted = {
      runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] },
    };
    const exposed = secret.exposeAsResource;
    new KubeNetworkPolicy(this, "ingress-boundary", {
      metadata: metadata(boundaryName, configWave),
      spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] },
    });
    new KubeNetworkPolicy(this, "from-guests", {
      metadata: metadata(fromGuestsName, configWave),
      spec: {
        podSelector: { matchLabels: { ...podLabels } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { ...guestSelector } } }], ports: [{ port: IntOrString.fromNumber(port), protocol: "TCP" }] }],
      },
    });
    new KubeConfigMap(this, "configuration", {
      metadata: metadata(configMapName, configWave),
      data: { "config.toml": props.configToml, "resource-policy.rego": this.policy },
    });
    new KubeService(this, "service", {
      metadata: metadata(name, configWave),
      spec: { selector: { ...podLabels }, ports: [{ name: "http", port, targetPort: IntOrString.fromNumber(port) }] },
    });
    new KubeDeployment(this, "deployment", {
      metadata: metadata(name, brokerWave),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { ...podLabels } },
        template: {
          metadata: { labels: { ...podLabels }, annotations: { [`${domain}/config-sha256`]: this.configSha256 } },
          spec: {
            nodeName,
            automountServiceAccountToken: false,
            ...(imagePullSecrets ? { imagePullSecrets } : {}),
            initContainers: [{
              name: ephemeral ? "initialize-issuer" : "initialize-registry",
              image: initImage,
              command: [...initCommand],
              securityContext: restricted,
              volumeMounts: ephemeral ? [{ name: "state", mountPath: "/state" }] : [
                { name: "state", mountPath: "/state" },
                { name: "registry", mountPath: "/registry", readOnly: true },
                { name: "configuration", mountPath: "/configuration", readOnly: true },
              ],
            }],
            containers: [{
              name: "broker",
              image: brokerImage,
              securityContext: restricted,
              command: ["/usr/local/bin/kbs", "--config-file", "/configuration/config.toml"],
              env: [{ name: "RUST_LOG", value: "info" }],
              resources: {
                requests: { cpu: Quantity.fromString("50m"), memory: Quantity.fromString("128Mi") },
                limits: { memory: Quantity.fromString("512Mi") },
              },
              ports: [{ name: "http", containerPort: port }],
              readinessProbe: { tcpSocket: { port: IntOrString.fromString("http") }, periodSeconds: 2 },
              volumeMounts: [
                { name: "state", mountPath: "/state" },
                { name: "configuration", mountPath: "/configuration", readOnly: true },
                ...(policyReadOnly ? [{ name: "policy", mountPath: "/state/kbs", readOnly: true }] : []),
                ...(exposed ? [{ name: "registry-resource", mountPath: "/state/repository", readOnly: true }] : []),
              ],
            }],
            volumes: [
              { name: "state", emptyDir: { medium: "Memory", sizeLimit: Quantity.fromString("64Mi") } },
              ...(ephemeral ? [] : [{ name: "registry", secret: { secretName, defaultMode: 0o400 } }]),
              { name: "configuration", configMap: { name: configMapName } },
              ...(policyReadOnly ? [{ name: "policy", configMap: { name: configMapName,
                items: [{ key: "resource-policy.rego", path: "resource-policy.rego" }] } }] : []),
              // The KBS local store keeps a resource in one file named by its
              // path with each "/" written as \x2F.
              ...(exposed ? [{ name: "registry-resource", secret: { secretName, defaultMode: 0o400,
                items: [{ key: ".dockerconfigjson", path: resourcePath.join("\\x2F") }] } }] : []),
            ],
          },
        },
      },
    });
  }

  /** The URL guests reach the broker at, for a cluster DNS domain (default `cluster.local`). */
  public endpoint(clusterDomain = "cluster.local"): string {
    return `http://${this.host}.${dnsSubdomain(WHERE, "clusterDomain", clusterDomain)}:${this.port}`;
  }
}
