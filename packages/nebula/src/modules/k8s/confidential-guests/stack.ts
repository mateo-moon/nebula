import { Construct } from "constructs";
import { GuestAdmissionFence, type GuestAdmissionFenceController, type GuestAdmissionFenceProps } from "./admission-fence";
import {
  GuestLifecycle, guestLifecycleSpec, lifecycleLabelKey, lifecycleNames, type ArgoIgnoreDifference, type GuestLifecycleProps,
} from "./lifecycle";
import { GuestLogRetention, type GuestLogRetentionProps, type GuestLogScope } from "./log-retention";
import { GuestServices, type GuestServicesProps } from "./services";
import { SignedReleases, type SignedReleasesProps } from "./signed-releases";
import { fail, list } from "./shared";

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
   * `guestClaimPrefix`.
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
  /** The attested pull broker, rendered first. */
  readonly pullBroker?: ConfidentialGuestComponent;
  /** Sealed-disk provisioning and volumes, rendered after the Services. */
  readonly disks?: ConfidentialGuestComponent;
  /** The NRI key injector, rendered after the disks. */
  readonly keyInjector?: ConfidentialGuestComponent;
}

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
 * containers, and the host components receive the guests' Pod names, claims
 * and HOST_DATA through {@link ConfidentialGuestStackContext}. Every lifecycle
 * check runs before anything renders.
 */
export class ConfidentialGuestStack extends Construct {
  public readonly context: ConfidentialGuestStackContext;
  public readonly lifecycle: GuestLifecycle;
  public readonly releases?: SignedReleases;

  constructor(scope: Construct, id: string, props: ConfidentialGuestStackProps) {
    super(scope, id);
    const { namespace, nodeName, runtimeClassName, labelDomain } = props;
    if (props.lifecycle === null || typeof props.lifecycle !== "object") fail(OWNER, "lifecycle is required");
    if (props.fence === null || typeof props.fence !== "object") fail(OWNER, "fence is required");
    const lifecycleProps: GuestLifecycleProps = { ...props.lifecycle, namespace, nodeName, runtimeClassName, labelDomain };
    const roles = list<GuestLifecycleProps["roles"][number]>(OWNER, "lifecycle.roles", lifecycleProps.roles, 1);
    const specs = roles.map(role => guestLifecycleSpec(lifecycleProps, role.role));

    const prefix = props.fence.guestClaimPrefix;
    for (const role of roles) {
      for (const claim of [role.claim, ...(role.stage ? [role.stage.claim] : [])]) {
        if (typeof prefix !== "string" || !claim.startsWith(prefix)) {
          fail(OWNER, `claim ${JSON.stringify(claim)} of role ${role.role} is outside fence.guestClaimPrefix ${JSON.stringify(prefix)}`);
        }
      }
    }
    for (const [name, build] of [["pullBroker", props.pullBroker], ["disks", props.disks], ["keyInjector", props.keyInjector]] as const) {
      if (build !== undefined && typeof build !== "function") fail(OWNER, `${name} must be a function (scope, context) => void`);
    }
    const component = (name: string, build: ConfidentialGuestComponent | undefined) => build?.(new Construct(this, name), this.context);

    this.context = {
      namespace, nodeName, runtimeClassName, labelDomain, lifecycleLabel: lifecycleLabelKey(labelDomain),
      initDataSha256: [...new Set(specs.flatMap(spec => Object.values(spec.releases).map(release => release.init_data_sha256)))],
      guestPods: roles.flatMap(role => [role.holder, ...(role.stage ? [role.stage.name] : [])]),
      roles: roles.map(role => ({ role: role.role, holder: role.holder, claim: role.claim, generation: role.generation,
        ...(role.stage ? { stage: { name: role.stage.name, claim: role.stage.claim } } : {}) })),
    };

    component("pull-broker", props.pullBroker);
    if (props.releases) this.releases = new SignedReleases(this, "releases", { ...props.releases, namespace });
    if (props.services) new GuestServices(this, "services", { ...props.services, namespace });
    component("disks", props.disks);
    component("key-injector", props.keyInjector);
    if (props.logRetention) {
      const scopes = props.logRetention.scopes ?? [
        ...roles.map((role, i) => ({ pod: role.holder, containers: specs[i].containers })),
        ...roles.flatMap(role => (role.stage ? [{ pod: role.stage.name, containers: role.stage.containers }] : [])),
      ];
      new GuestLogRetention(this, "log-retention", { ...props.logRetention, namespace, nodeName, labelDomain, scopes });
    }
    const controllers: GuestAdmissionFenceController[] = props.fence.controllers ? [...props.fence.controllers] : roles.map(role => ({
      serviceAccount: { namespace, name: lifecycleNames(role.role).controller },
      guests: [{ name: role.holder, claimPrefix: guestClaimPrefix(role.claim) },
        ...(role.stage ? [{ name: role.stage.name, claimPrefix: guestClaimPrefix(role.stage.claim) }] : [])],
    }));
    new GuestAdmissionFence(this, "fence", {
      ...props.fence, runtimeClassName, nodeName, controllers,
      namespaceSelector: props.fence.namespaceSelector ?? { matchLabels: { "kubernetes.io/metadata.name": namespace } },
    });
    this.lifecycle = new GuestLifecycle(this, "lifecycle", lifecycleProps);
  }

  /** Argo CD `ignoreDifferences` for the controllers' ledgers; set them on the Application. */
  public ignoreDifferences(): ArgoIgnoreDifference[] {
    return this.lifecycle.ignoreDifferences();
  }
}
