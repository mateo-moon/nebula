import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { GuestAdmissionFence, type GuestAdmissionFenceController, type GuestAdmissionFenceProps } from "./admission-fence";
import {
  GuestLifecycle, guestLifecycleSpec, lifecycleLabelKey, lifecycleNames, type ArgoIgnoreDifference, type GuestLifecycleProps,
} from "./lifecycle";
import { NriKeyInjector, type NriKeyInjectorProps } from "./key-injector";
import { GuestLogRetention, type GuestLogRetentionProps, type GuestLogScope } from "./log-retention";
import { AttestedPullBroker, type AttestedPullBrokerProps } from "./pull-broker";
import { SealedDisks, type SealedDisksProps } from "./sealed-disks";
import { GuestServices, type GuestServicesProps } from "./services";
import { SignedReleases, type SignedReleasesProps } from "./signed-releases";
import { dnsLabel, dnsSubdomain, fail, labelDomain as domainOf, list } from "./validate";

const OWNER = "ConfidentialGuestStack";

/** One lifecycle role as the host components see it. */
export interface ConfidentialGuestRoleContext {
  readonly role: string;
  readonly holder: string;
  readonly claim: string;
  readonly generation: number;
  readonly stage?: { readonly name: string; readonly claim: string };
}

/** What the stack derives from its roles, handed to the host components it does not build itself. */
export interface ConfidentialGuestStackContext {
  readonly namespace: string;
  readonly nodeName: string;
  readonly runtimeClassName: string;
  readonly labelDomain: string;
  /** The label key the lifecycle controllers set on their guests (`holder` or `stage`). */
  readonly lifecycleLabel: string;
  /** HOST_DATA of every declared release, role by role in declaration order, without repeats: what a pull broker admits. */
  readonly initDataSha256: readonly string[];
  /** Every guest Pod a controller may create, role by role: the holder, then its stage boot. What a key injector binds. */
  readonly guestPods: readonly string[];
  /** Per role, the Pods and claims a disk provisioner serves. */
  readonly roles: readonly ConfidentialGuestRoleContext[];
}

/** Builds a host component (pull broker, sealed disks, key injector) under `scope`. */
export type ConfidentialGuestComponent = (scope: Construct, context: ConfidentialGuestStackContext) => void;

/**
 * The attested pull broker as the stack builds it: in the stack's namespace,
 * on its node, under its label domain, admitting the HOST_DATA of every
 * declared release (`initData` is `{ form: "in", values: context.initDataSha256 }`).
 */
export type ConfidentialGuestPullBroker = Omit<AttestedPullBrokerProps, "namespace" | "nodeName" | "labelDomain" | "initData">;
/**
 * Sealed disks as the stack builds them, in its namespace on its node. Every
 * guest's claim (holder and stage boot) must be a live disk of the table.
 * With `injector`, SealedDisks also renders the key injector (between the
 * provisioners and the claims), bound only to the stack's guest Pods.
 */
export type ConfidentialGuestDisks = Omit<SealedDisksProps, "namespace" | "nodeName">;
/**
 * A standalone key injector, in the stack's namespace on its node, bound only
 * to the stack's guest Pods: for disks the stack does not build. When the
 * stack builds the disks, give the injector to them (`disks.injector`).
 */
export type ConfidentialGuestKeyInjector = Omit<NriKeyInjectorProps, "namespace" | "nodeName" | "targetNamespace">;

export interface ConfidentialGuestStackProps {
  readonly namespace: string;
  readonly nodeName: string;
  readonly runtimeClassName: string;
  /** Domain of every label and annotation key the stack writes. Required, no default. */
  readonly labelDomain: string;
  /** Roles, releases and the controller ({@link GuestLifecycle}). */
  readonly lifecycle: Omit<GuestLifecycleProps, "namespace" | "nodeName" | "runtimeClassName" | "labelDomain">;
  /**
   * The admission fence ({@link GuestAdmissionFence}). By default the
   * controllers and their guests derive from the lifecycle roles (a claim's
   * trailing generation number is dropped from its prefix) and the namespace
   * selector is the stack's own namespace. Every role claim must start with
   * `guestClaimPrefix`; given controllers must list each role's guests under
   * that role's controller, with prefixes that admit the role's claims.
   */
  readonly fence: Omit<GuestAdmissionFenceProps, "namespaceSelector" | "controllers" | "runtimeClassName" | "nodeName">
    & Partial<Pick<GuestAdmissionFenceProps, "namespaceSelector" | "controllers">>;
  /** Signed release statements the guests mount ({@link SignedReleases}). */
  readonly releases?: Omit<SignedReleasesProps, "namespace">;
  /** NetworkPolicies and Services ({@link GuestServices}). */
  readonly services?: Omit<GuestServicesProps, "namespace">;
  /**
   * Host-side log retention ({@link GuestLogRetention}). Scopes default to
   * each holder's containers (its current release), then each stage boot's.
   */
  readonly logRetention?: Omit<GuestLogRetentionProps, "namespace" | "nodeName" | "labelDomain" | "scopes">
    & { readonly scopes?: readonly GuestLogScope[] };
  /** The attested pull broker, rendered first: its props, or a function that builds it. */
  readonly pullBroker?: ConfidentialGuestPullBroker | ConfidentialGuestComponent;
  /** Sealed-disk provisioning and volumes (and their key injector), rendered after the Services: their props, or a function. */
  readonly disks?: ConfidentialGuestDisks | ConfidentialGuestComponent;
  /**
   * A standalone NRI key injector, rendered after the disks: its props, or a
   * function. Only for disks the stack does not build: SealedDisks renders
   * its own injector (`disks.injector`), and the stack refuses a second one.
   */
  readonly keyInjector?: ConfidentialGuestKeyInjector | ConfidentialGuestComponent;
}

// What the stack sets on a component it builds from props.
const STACK_SETS = {
  pullBroker: ["namespace", "nodeName", "labelDomain", "initData"],
  disks: ["namespace", "nodeName"],
  keyInjector: ["namespace", "nodeName", "targetNamespace"],
} as const;

/** The admission prefix of a claim: the claim without its trailing generation number. */
export function guestClaimPrefix(claim: string): string {
  return claim.replace(/[0-9]+$/, "");
}

/**
 * A complete confidential-guest deployment in one namespace, rendered in
 * this order: pull broker, signed releases, Services, disks, key injector,
 * log retention, admission fence, lifecycle controllers. The controllers act
 * as soon as they run, so everything their guests need renders before them.
 *
 * The stack wires the parts together: the fence admits exactly the lifecycle
 * controllers and their guests, log retention follows the guests'
 * containers, the pull broker admits every declared release, the disks
 * serve every guest claim and an injector binds only the guests. The host
 * components are given as their constructs' props, or as functions that
 * receive the guests' Pod names, claims and HOST_DATA through
 * {@link ConfidentialGuestStackContext}. No two parts may render the same
 * object. A refusal anywhere leaves nothing rendered.
 */
export class ConfidentialGuestStack extends Construct {
  public readonly context: ConfidentialGuestStackContext;
  public readonly lifecycle: GuestLifecycle;
  public readonly releases?: SignedReleases;

  constructor(scope: Construct, id: string, props: ConfidentialGuestStackProps) {
    super(scope, id);
    try {
      const { namespace, nodeName, runtimeClassName, labelDomain } = props;
      dnsLabel(OWNER, "namespace", namespace);
      dnsSubdomain(OWNER, "nodeName", nodeName);
      dnsSubdomain(OWNER, "runtimeClassName", runtimeClassName);
      domainOf(OWNER, "labelDomain", labelDomain);
      if (props.lifecycle === null || typeof props.lifecycle !== "object") fail(OWNER, "lifecycle is required");
      if (props.fence === null || typeof props.fence !== "object") fail(OWNER, "fence is required");
      const lifecycleProps: GuestLifecycleProps = { ...props.lifecycle, namespace, nodeName, runtimeClassName, labelDomain };
      const roles = list<GuestLifecycleProps["roles"][number]>(OWNER, "lifecycle.roles", lifecycleProps.roles, 1);
      const specs = roles.map(role => guestLifecycleSpec(lifecycleProps, role.role));
      const guestsOf = (role: (typeof roles)[number]) => [[role.holder, role.claim], ...(role.stage ? [[role.stage.name, role.stage.claim]] : [])];

      const prefix = props.fence.guestClaimPrefix;
      for (const role of roles) {
        for (const [, claim] of guestsOf(role)) {
          if (typeof prefix !== "string" || !claim.startsWith(prefix)) {
            fail(OWNER, `claim ${JSON.stringify(claim)} of role ${role.role} is outside fence.guestClaimPrefix ${JSON.stringify(prefix)}`);
          }
        }
      }
      const controllers: GuestAdmissionFenceController[] = props.fence.controllers
        ? [...list<GuestAdmissionFenceController>(OWNER, "fence.controllers", props.fence.controllers, 1)]
        : roles.map(role => ({
          serviceAccount: { namespace, name: lifecycleNames(role.role).controller },
          guests: guestsOf(role).map(([name, claim]) => ({ name, claimPrefix: guestClaimPrefix(claim) })),
        }));
      // The fence admits a controller's guests by name and each guest's claims by
      // prefix; the fence itself refuses prefixes that overlap.
      for (const role of roles) {
        const account = `${namespace}/${lifecycleNames(role.role).controller}`;
        const own = controllers.find(c => `${c?.serviceAccount?.namespace}/${c?.serviceAccount?.name}` === account)?.guests ?? [];
        for (const [pod, claim] of guestsOf(role)) {
          const guest = own.find(g => g?.name === pod)
            ?? fail(OWNER, `role ${role.role}: guest ${pod} is not a guest of its controller ${account} in fence.controllers`);
          if (typeof guest.claimPrefix !== "string" || !claim.startsWith(guest.claimPrefix)) {
            fail(OWNER, `role ${role.role}: claim ${claim} is outside guest ${pod}'s claimPrefix ${JSON.stringify(guest.claimPrefix)}`);
          }
        }
      }
      for (const name of ["pullBroker", "disks", "keyInjector"] as const) {
        const given = props[name];
        if (given === undefined || typeof given === "function") continue;
        if (given === null || typeof given !== "object" || Array.isArray(given)) fail(OWNER, `${name} must be its construct's props or a function (scope, context) => void`);
        const set = STACK_SETS[name].filter(key => key in given);
        if (set.length) fail(OWNER, `${name}: the stack sets ${set.join(", ")}`);
      }
      if (typeof props.disks === "object" && props.disks.injector !== undefined && props.keyInjector !== undefined) {
        fail(OWNER, "keyInjector: disks already renders the key injector (disks.injector); keyInjector is for a standalone NriKeyInjector");
      }
      const component = (name: string, build: ConfidentialGuestComponent | undefined) => build?.(new Construct(this, name), this.context);
      // A malformed binding list is left for the injector to refuse.
      const guestPodsOnly = (what: string, bindings: unknown) => {
        for (const pod of new Set((Array.isArray(bindings) ? bindings : []).map(binding => binding?.pod))) {
          if (!this.context.guestPods.includes(pod)) fail(OWNER, `${what} binds ${pod}, which is not a guest Pod of the stack`);
        }
      };

      this.context = {
        namespace, nodeName, runtimeClassName, labelDomain, lifecycleLabel: lifecycleLabelKey(labelDomain),
        initDataSha256: [...new Set(specs.flatMap(spec => Object.values(spec.releases).map(release => release.init_data_sha256)))],
        guestPods: roles.flatMap(role => [role.holder, ...(role.stage ? [role.stage.name] : [])]),
        roles: roles.map(role => ({ role: role.role, holder: role.holder, claim: role.claim, generation: role.generation,
          ...(role.stage ? { stage: { name: role.stage.name, claim: role.stage.claim } } : {}) })),
      };

      if (typeof props.pullBroker === "object") {
        new AttestedPullBroker(this, "pull-broker", {
          ...props.pullBroker, namespace, nodeName, labelDomain, initData: { form: "in", values: this.context.initDataSha256 },
        });
      } else {
        component("pull-broker", props.pullBroker);
      }
      if (props.releases) this.releases = new SignedReleases(this, "releases", { ...props.releases, namespace });
      if (props.services) new GuestServices(this, "services", { ...props.services, namespace });
      if (typeof props.disks === "object") {
        guestPodsOnly("disks.injector", props.disks.injector?.bindings);
        const disks = new SealedDisks(this, "disks", { ...props.disks, namespace, nodeName });
        const live = disks.plan.live.map(disk => disk.claim);
        for (const role of roles) {
          for (const [, claim] of guestsOf(role)) {
            if (!live.includes(claim)) fail(OWNER, `role ${role.role}: claim ${claim} is not a live disk of disks (live: ${live.join(", ")})`);
          }
        }
      } else {
        component("disks", props.disks);
      }
      if (typeof props.keyInjector === "object") {
        guestPodsOnly("keyInjector", props.keyInjector.bindings);
        new NriKeyInjector(this, "key-injector", { ...props.keyInjector, namespace, nodeName });
      } else {
        component("key-injector", props.keyInjector);
      }
      if (props.logRetention) {
        const scopes = props.logRetention.scopes ?? [
          ...roles.map((role, i) => ({ pod: role.holder, containers: specs[i].containers })),
          ...roles.flatMap(role => (role.stage ? [{ pod: role.stage.name, containers: role.stage.containers }] : [])),
        ];
        new GuestLogRetention(this, "log-retention", { ...props.logRetention, namespace, nodeName, labelDomain, scopes });
      }
      new GuestAdmissionFence(this, "fence", {
        ...props.fence, runtimeClassName, nodeName, controllers,
        namespaceSelector: props.fence.namespaceSelector ?? { matchLabels: { "kubernetes.io/metadata.name": namespace } },
      });
      this.lifecycle = new GuestLifecycle(this, "lifecycle", lifecycleProps);

      const rendered = new Set<string>();
      for (const object of this.node.findAll().filter(ApiObject.isApiObject)) {
        const where = object.metadata.namespace ?? object.chart.namespace;
        const key = `${object.kind}${object.apiGroup === "core" ? "" : `.${object.apiGroup}`} ${where ? `${where}/` : ""}${object.name}`;
        if (rendered.has(key)) fail(OWNER, `${key} is rendered twice; every part must name its objects apart`);
        rendered.add(key);
      }
    } catch (error) {
      scope.node.tryRemoveChild(this.node.id);
      throw error;
    }
  }

  /** Argo CD `ignoreDifferences` for the controllers' ledgers; set them on the Application. */
  public ignoreDifferences(): ArgoIgnoreDifference[] {
    return this.lifecycle.ignoreDifferences();
  }
}
