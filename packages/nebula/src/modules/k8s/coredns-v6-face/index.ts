/**
 * The IPv6 face of CoreDNS for a k0s dual-stack cluster.
 *
 * k0s derives the kube-dns ClusterIP from the PRIMARY service CIDR, which k0s
 * pins to IPv4 (dual-stack is v4-primary by validation, and the primary
 * family cannot be flipped — verified empirically against v1.33/v1.34).
 * Cross-region pods reaching a v4 ClusterIP get DNAT'd to a v4 CoreDNS pod
 * IP — private, unroutable across regions once node identity is on-link
 * (GUA + private v4). This Service is the same CoreDNS pods behind a v6
 * ClusterIP: kube-proxy DNATs to the pods' v6 addresses and the query rides
 * WireGuard-v6 between on-link GUAs.
 *
 * The ClusterIP is static: kubelet needs a literal address for
 * `--cluster-dns` (see AwsWorkerFleetOptions.clusterDns), and DNS ClusterIPs
 * are conventionally pinned — 10.96.0.10 is k0s's own such constant.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

export interface CorednsV6FaceOptions {
  /** Static v6 ClusterIP inside the cluster's v6 service CIDR, e.g.
   *  "fd01::53" under the conventional fd01::/108. */
  clusterIp: string;
  /** CoreDNS namespace (default "kube-system"). */
  namespace?: string;
  /** Service name (default "coredns-v6"). */
  name?: string;
  /** CoreDNS pod selector (default k0s's `k8s-app: kube-dns`). */
  selector?: Record<string, string>;
}

export class CorednsV6Face extends Construct {
  constructor(scope: Construct, id: string, options: CorednsV6FaceOptions) {
    super(scope, id);
    const name = options.name ?? "coredns-v6";
    new ApiObject(this, "service", {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name,
        namespace: options.namespace ?? "kube-system",
        labels: { "k8s-app": name },
      },
      spec: {
        selector: options.selector ?? { "k8s-app": "kube-dns" },
        ipFamilies: ["IPv6"],
        ipFamilyPolicy: "SingleStack",
        clusterIP: options.clusterIp,
        ports: [
          { name: "dns", port: 53, protocol: "UDP", targetPort: 53 },
          { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
        ],
      },
    });
  }
}
