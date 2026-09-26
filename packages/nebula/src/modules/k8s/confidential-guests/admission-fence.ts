import { Construct } from "constructs";
import { KubeValidatingAdmissionPolicy, KubeValidatingAdmissionPolicyBinding } from "cdk8s-plus-33/lib/imports/k8s";
import { INIT_DATA_ANNOTATION } from "./measured";
import { LIFECYCLE_DATA_VOLUME } from "./lifecycle";
import { ARGO_TRACKING_ID, dnsLabel, dnsSubdomain, fail, labelKey, labelValue, list, nonEmptyString, syncWave, unique, waveAnnotations } from "./shared";

const OWNER = "GuestAdmissionFence";

/** A guest Pod a controller may create, and the prefix its data claim must start with. */
export interface GuestAdmissionFenceGuest {
  readonly name: string;
  readonly claimPrefix: string;
}

/** A controller ServiceAccount and the guests it alone may create. */
export interface GuestAdmissionFenceController {
  readonly serviceAccount: { readonly namespace: string; readonly name: string };
  readonly guests: readonly GuestAdmissionFenceGuest[];
}

/** The denial message of each check. Required: tooling may match on them. */
export interface GuestAdmissionFenceMessages {
  /** Someone other than a controller creates a guest. */
  readonly creator: string;
  /** A controller creates a Pod name outside its role. */
  readonly name: string;
  /** Wrong runtime class, node or restart policy. */
  readonly placement: string;
  /** Host network, PID or IPC namespaces, or a shared process namespace. */
  readonly hostNamespaces: string;
  /** A ServiceAccount other than `default`, or a mounted token. */
  readonly serviceAccount: string;
  /** A volume type other than configMap, emptyDir or persistentVolumeClaim. */
  readonly volumes: string;
  /** Not exactly one claim, named `data`, of the guest's own role. */
  readonly claim: string;
  /** A privileged or escalating container. */
  readonly privilege: string;
  /** No init-data, or an Argo tracking id (the guest would belong to Argo). */
  readonly initData: string;
}

/**
 * A label selector for the namespaces the fence applies to. It must name its
 * namespaces with a `matchLabels` entry or an `In` expression; `NotIn`,
 * `Exists` and `DoesNotExist` may only narrow that selection.
 */
export interface GuestAdmissionFenceNamespaceSelector {
  readonly matchLabels?: Readonly<Record<string, string>>;
  readonly matchExpressions?: readonly { readonly key: string; readonly operator: "In" | "NotIn" | "Exists" | "DoesNotExist"; readonly values?: readonly string[] }[];
}

export interface GuestAdmissionFenceProps {
  /**
   * The namespaces the fence applies to. Required, and it must name them:
   * ValidatingAdmissionPolicies are cluster-scoped, so a selector that
   * matches nearly every namespace would deny runtime-class Pods in all of
   * them (including other guests').
   */
  readonly namespaceSelector: GuestAdmissionFenceNamespaceSelector;
  /**
   * Names of the two policies (each binding takes its policy's name).
   * Required: they are cluster-scoped, so two deployments must not share them.
   */
  readonly policyNames: { readonly creator: string; readonly shape: string };
  readonly messages: GuestAdmissionFenceMessages;
  /**
   * The controllers and their guests; the last controller is the fallback
   * branch of the name and claim checks. Every guest's claim prefix starts
   * with `guestClaimPrefix` and neither covers nor is covered by another
   * guest's, so a guest mounts only its own claims.
   */
  readonly controllers: readonly GuestAdmissionFenceController[];
  /** Runtime class of every guest. */
  readonly runtimeClassName: string;
  /** Node every guest runs on. */
  readonly nodeName: string;
  /** A Pod mounting a claim with this prefix is a guest, whatever its runtime class. */
  readonly guestClaimPrefix: string;
  /** Names of the policies' match conditions. Default `confidential-guest` and `lifecycle-controller`. */
  readonly conditionNames?: { readonly guest?: string; readonly controller?: string };
  /** Argo sync wave. Default `-2`. */
  readonly wave?: string;
}

// Values interpolated into CEL string literals: validated so they can never
// close the literal (no quotes or backslashes can pass these patterns).
const CLAIM_PREFIX = /^[a-z0-9]([-a-z0-9.]*)?$/;
const OPERATORS = ["In", "NotIn", "Exists", "DoesNotExist"];
const SELECT_NAMESPACES = "namespaceSelector is required and must name its namespaces (a matchLabels entry or an In expression): the policies are cluster-scoped";
const quote = (value: string) => `'${value}'`;
const names = (values: readonly string[]) => `[${values.map(quote).join(", ")}]`;

/** Nested CEL conditional: `c1 ? v1 : c2 ? v2 : vLast`. */
function choose(branches: readonly (readonly [condition: string, value: string])[]): string {
  return branches.slice(0, -1).reduceRight((otherwise, [condition, value]) => `${condition} ? ${value} : ${otherwise}`, branches[branches.length - 1][1]);
}

/**
 * Admission interlocks for controller-created guests: two cluster-scoped
 * ValidatingAdmissionPolicies with their bindings.
 * - The creator policy: a Pod that is a guest (runtime class, or a claim under
 *   the guest prefix) is created only by a lifecycle controller.
 * - The shape policy: a controller creates only its own guests, on the node
 *   and runtime class, with restartPolicy Never, no host namespaces, the
 *   default ServiceAccount without a token, configMap/emptyDir/PVC volumes,
 *   exactly one `data` claim of its role, unprivileged containers, init-data
 *   and no Argo tracking id.
 * Init-data content is not compared here; attestation binds it.
 */
export class GuestAdmissionFence extends Construct {
  constructor(scope: Construct, id: string, props: GuestAdmissionFenceProps) {
    super(scope, id);
    const selector = props.namespaceSelector;
    if (selector === null || typeof selector !== "object" || Array.isArray(selector)) fail(OWNER, SELECT_NAMESPACES);
    const matchLabels = selector.matchLabels ?? {};
    if (matchLabels === null || typeof matchLabels !== "object" || Array.isArray(matchLabels)) fail(OWNER, "namespaceSelector.matchLabels must be a map of labels");
    for (const [key, value] of Object.entries(matchLabels)) {
      labelKey(OWNER, "namespaceSelector key", key);
      labelValue(OWNER, `namespaceSelector[${key}]`, value);
    }
    const matchExpressions = list<NonNullable<GuestAdmissionFenceNamespaceSelector["matchExpressions"]>[number]>(
      OWNER, "namespaceSelector.matchExpressions", selector.matchExpressions ?? []);
    for (const expression of matchExpressions) {
      const key = labelKey(OWNER, "namespaceSelector expression key", expression?.key);
      if (!OPERATORS.includes(expression.operator)) fail(OWNER, `namespaceSelector expression ${key}: operator must be one of ${OPERATORS.join(", ")}`);
      const values = list<string>(OWNER, `namespaceSelector expression ${key} values`, expression.values ?? []);
      const takesValues = expression.operator === "In" || expression.operator === "NotIn";
      if (takesValues && values.length === 0) fail(OWNER, `namespaceSelector expression ${key}: ${expression.operator} needs values`);
      if (!takesValues && values.length > 0) fail(OWNER, `namespaceSelector expression ${key}: ${expression.operator} takes no values`);
      values.forEach(value => labelValue(OWNER, `namespaceSelector expression ${key} value`, value));
    }
    if (Object.keys(matchLabels).length === 0 && !matchExpressions.some(e => e.operator === "In")) fail(OWNER, SELECT_NAMESPACES);
    const policyNames = props.policyNames ?? fail(OWNER, "policyNames is required: the policies are cluster-scoped");
    dnsSubdomain(OWNER, "policyNames.creator", policyNames.creator);
    dnsSubdomain(OWNER, "policyNames.shape", policyNames.shape);
    if (policyNames.creator === policyNames.shape) fail(OWNER, "policyNames.creator and policyNames.shape must differ");
    const messages = props.messages ?? fail(OWNER, "messages are required");
    for (const key of ["creator", "name", "placement", "hostNamespaces", "serviceAccount", "volumes", "claim", "privilege", "initData"] as const) {
      nonEmptyString(OWNER, `messages.${key}`, messages[key]);
    }
    const runtimeClassName = dnsSubdomain(OWNER, "runtimeClassName", props.runtimeClassName);
    const nodeName = dnsSubdomain(OWNER, "nodeName", props.nodeName);
    const guestClaimPrefix = props.guestClaimPrefix;
    if (typeof guestClaimPrefix !== "string" || !CLAIM_PREFIX.test(guestClaimPrefix)) fail(OWNER, "guestClaimPrefix must be a claim name prefix");
    const conditionNames = { guest: props.conditionNames?.guest ?? "confidential-guest", controller: props.conditionNames?.controller ?? "lifecycle-controller" };
    dnsSubdomain(OWNER, "conditionNames.guest", conditionNames.guest);
    dnsSubdomain(OWNER, "conditionNames.controller", conditionNames.controller);
    const wave = syncWave(OWNER, "wave", props.wave ?? "-2");

    const controllers = list<GuestAdmissionFenceController>(OWNER, "controllers", props.controllers, 1);
    const accounts = controllers.map(c => {
      dnsLabel(OWNER, "controller namespace", c?.serviceAccount?.namespace);
      dnsSubdomain(OWNER, "controller ServiceAccount", c.serviceAccount.name);
      return `system:serviceaccount:${c.serviceAccount.namespace}:${c.serviceAccount.name}`;
    });
    unique(OWNER, "controller", accounts);
    const guests = controllers.flatMap(c => list<GuestAdmissionFenceGuest>(OWNER, "controller guests", c.guests, 1));
    for (const guest of guests) {
      dnsSubdomain(OWNER, "guest name", guest?.name);
      if (typeof guest.claimPrefix !== "string" || !CLAIM_PREFIX.test(guest.claimPrefix)) fail(OWNER, `guest ${guest.name} claimPrefix must be a claim name prefix`);
    }
    unique(OWNER, "guest", guests.map(g => g.name));
    for (const guest of guests) {
      if (!guest.claimPrefix.startsWith(guestClaimPrefix)) {
        fail(OWNER, `guest ${guest.name} claimPrefix ${JSON.stringify(guest.claimPrefix)} is outside guestClaimPrefix ${JSON.stringify(guestClaimPrefix)}: the creator policy would not fence its claims`);
      }
      for (const other of guests) {
        if (other !== guest && other.claimPrefix.startsWith(guest.claimPrefix)) {
          fail(OWNER, `guest ${guest.name} claimPrefix ${JSON.stringify(guest.claimPrefix)} overlaps guest ${other.name}'s ${JSON.stringify(other.claimPrefix)}: a guest may mount only its own claims`);
        }
      }
    }

    const username = "request.userInfo.username";
    const isController = `${username} in ${names(accounts)}`;
    const nameOf = (c: GuestAdmissionFenceController) => c.guests.length === 1
      ? `object.metadata.name == ${quote(c.guests[0].name)}` : `object.metadata.name in ${names(c.guests.map(g => g.name))}`;
    const unprivileged = "!has(c.securityContext) || (!(has(c.securityContext.privileged) && c.securityContext.privileged)"
      + " && !(has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation))";
    const policies = [
      [policyNames.creator, {
        matchConditions: [{ name: conditionNames.guest,
          expression: `(has(object.spec.runtimeClassName) && object.spec.runtimeClassName == ${quote(runtimeClassName)})`
            + " || (has(object.spec.volumes) && object.spec.volumes.exists(v, has(v.persistentVolumeClaim)"
            + ` && v.persistentVolumeClaim.claimName.startsWith(${quote(guestClaimPrefix)})))` }],
        validations: [{ expression: isController, message: messages.creator }],
      }],
      [policyNames.shape, {
        matchConditions: [{ name: conditionNames.controller, expression: isController }],
        validations: [
          { expression: choose(controllers.map((c, i) => [`${username} == ${quote(accounts[i])}`, nameOf(c)] as const)), message: messages.name },
          { expression: `has(object.spec.runtimeClassName) && object.spec.runtimeClassName == ${quote(runtimeClassName)}`
            + ` && has(object.spec.nodeName) && object.spec.nodeName == ${quote(nodeName)} && object.spec.restartPolicy == 'Never'`,
            message: messages.placement },
          { expression: "!(has(object.spec.hostNetwork) && object.spec.hostNetwork) && !(has(object.spec.hostPID) && object.spec.hostPID)"
            + " && !(has(object.spec.hostIPC) && object.spec.hostIPC)"
            + " && !(has(object.spec.shareProcessNamespace) && object.spec.shareProcessNamespace)",
            message: messages.hostNamespaces },
          { expression: "(!has(object.spec.serviceAccountName) || object.spec.serviceAccountName == 'default')"
            + " && has(object.spec.automountServiceAccountToken) && object.spec.automountServiceAccountToken == false",
            message: messages.serviceAccount },
          { expression: "has(object.spec.volumes) && object.spec.volumes.all(v, has(v.configMap) || has(v.emptyDir) || has(v.persistentVolumeClaim))",
            message: messages.volumes },
          { expression: "has(object.spec.volumes) && object.spec.volumes.filter(v, has(v.persistentVolumeClaim)).size() == 1"
            + ` && object.spec.volumes.exists(v, v.name == ${quote(LIFECYCLE_DATA_VOLUME)} && has(v.persistentVolumeClaim)`
            + ` && v.persistentVolumeClaim.claimName.startsWith(${choose(guests.map(g => [`object.metadata.name == ${quote(g.name)}`, quote(g.claimPrefix)] as const))}))`,
            message: messages.claim },
          { expression: `object.spec.containers.all(c, ${unprivileged})`
            + ` && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, ${unprivileged}))`,
            message: messages.privilege },
          { expression: `has(object.metadata.annotations) && ${quote(INIT_DATA_ANNOTATION)} in object.metadata.annotations`
            + ` && !(${quote(ARGO_TRACKING_ID)} in object.metadata.annotations)`,
            message: messages.initData },
        ],
      }],
    ] as const;
    const namespaceSelector = {
      ...(Object.keys(matchLabels).length ? { matchLabels: { ...matchLabels } } : {}),
      ...(matchExpressions.length ? { matchExpressions: matchExpressions.map(e => ({ key: e.key, operator: e.operator, ...(e.values ? { values: [...e.values] } : {}) })) } : {}),
    };
    for (const [name, spec] of policies) {
      new KubeValidatingAdmissionPolicy(this, name, { metadata: { name, annotations: waveAnnotations(wave) }, spec: {
        failurePolicy: "Fail",
        matchConstraints: { namespaceSelector, resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }] },
        matchConditions: spec.matchConditions.map(c => ({ ...c })),
        validations: spec.validations.map(v => ({ ...v })),
      } });
      // A policy enforces nothing without its binding.
      new KubeValidatingAdmissionPolicyBinding(this, `${name}-binding`, { metadata: { name, annotations: waveAnnotations(wave) },
        spec: { policyName: name, validationActions: ["Deny"], matchResources: { namespaceSelector } } });
    }
  }
}
