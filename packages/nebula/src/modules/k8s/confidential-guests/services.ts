import { Construct } from "constructs";
import { IntOrString, KubeNetworkPolicy, KubeService } from "cdk8s-plus-33/lib/imports/k8s";
import { dnsLabel, fail, ipAddress, labels, list, port, syncWave, unique, waveAnnotations } from "./validate";

const OWNER = "GuestServices";

/** Ingress to the Pods `podSelector` matches, on TCP `ports`, from `from` (default: any source). */
export interface GuestIngressRule {
  /** NetworkPolicy name. */
  readonly name: string;
  readonly podSelector: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  /** Source Pods, each a label selector in the same namespace. */
  readonly from?: readonly Readonly<Record<string, string>>[];
}

/** A Service in front of guest Pods, TCP only; each port is named `tcp-<port>` and targets itself. */
export interface GuestService {
  readonly name: string;
  readonly selector: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  /**
   * A fixed cluster address, for peers whose measured configuration names
   * it. Default: allocated by the cluster.
   */
  readonly clusterIP?: string;
  /**
   * Route to guests that are not ready, for a guest whose readiness can
   * legitimately be false while it must stay reachable. Rendered only when set.
   */
  readonly publishNotReadyAddresses?: boolean;
}

export interface GuestServicesProps {
  readonly namespace: string;
  /** Ingress NetworkPolicies, rendered first, in order. */
  readonly ingress?: readonly GuestIngressRule[];
  /** Services, rendered after the policies, in order. */
  readonly services?: readonly GuestService[];
  /** Argo sync wave. Default `-2`. */
  readonly wave?: string;
}

/**
 * The network surface of confidential guests: ingress NetworkPolicies that
 * open specific TCP ports to specific Pods, and Services, optionally at fixed
 * cluster addresses. No LoadBalancer, NodePort or Ingress is ever rendered.
 * To serve only a lifecycle holder, select on the lifecycle label
 * (`{ ...guestLabels, [lifecycle.lifecycleLabel]: "holder" }`).
 */
export class GuestServices extends Construct {
  constructor(scope: Construct, id: string, props: GuestServicesProps) {
    super(scope, id);
    const namespace = dnsLabel(OWNER, "namespace", props.namespace);
    const wave = syncWave(OWNER, "wave", props.wave ?? "-2");
    const ingress = list<GuestIngressRule>(OWNER, "ingress", props.ingress ?? []);
    const services = list<GuestService>(OWNER, "services", props.services ?? []);
    if (ingress.length + services.length === 0) fail(OWNER, "nothing to render: declare ingress or services");
    unique(OWNER, "NetworkPolicy", ingress.map(r => r?.name));
    unique(OWNER, "Service", services.map(s => s?.name));
    const ports = (what: string, value: unknown) => {
      const items = list<number>(OWNER, what, value, 1).map(p => port(OWNER, what, p));
      unique(OWNER, `${what} entry`, items.map(String));
      return items;
    };
    const metadata = (name: string) => ({ name, namespace, annotations: waveAnnotations(wave) });
    for (const rule of ingress) {
      dnsLabel(OWNER, "NetworkPolicy name", rule.name);
      const podSelector = labels(OWNER, `${rule.name} podSelector`, rule.podSelector);
      const from = rule.from === undefined ? undefined : list<Record<string, string>>(OWNER, `${rule.name} from`, rule.from, 1)
        .map((peer, i) => ({ podSelector: { matchLabels: { ...labels(OWNER, `${rule.name} from[${i}]`, peer) } } }));
      new KubeNetworkPolicy(this, rule.name, { metadata: metadata(rule.name), spec: {
        podSelector: { matchLabels: { ...podSelector } }, policyTypes: ["Ingress"],
        ingress: [{ ...(from ? { from } : {}), ports: ports(`${rule.name} ports`, rule.ports).map(p => ({ port: IntOrString.fromNumber(p), protocol: "TCP" })) }],
      } });
    }
    for (const service of services) {
      dnsLabel(OWNER, "Service name", service.name);
      const selector = labels(OWNER, `${service.name} selector`, service.selector);
      if (service.clusterIP !== undefined) ipAddress(OWNER, `${service.name} clusterIP`, service.clusterIP);
      if (service.publishNotReadyAddresses !== undefined && typeof service.publishNotReadyAddresses !== "boolean") {
        fail(OWNER, `${service.name} publishNotReadyAddresses must be a boolean`);
      }
      new KubeService(this, service.name, { metadata: metadata(service.name), spec: {
        ...(service.clusterIP !== undefined ? { clusterIp: service.clusterIP } : {}),
        selector: { ...selector },
        ...(service.publishNotReadyAddresses !== undefined ? { publishNotReadyAddresses: service.publishNotReadyAddresses } : {}),
        ports: ports(`${service.name} ports`, service.ports).map(p => ({ name: `tcp-${p}`, port: p, targetPort: IntOrString.fromNumber(p), protocol: "TCP" })),
      } });
    }
  }
}
