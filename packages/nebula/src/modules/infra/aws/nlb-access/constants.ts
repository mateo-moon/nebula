export const AWS_NLB_PREFIX_LIST_ANNOTATION = "service.beta.kubernetes.io/aws-load-balancer-security-group-prefix-lists";
/** No routable source is admitted before the observed prefix list is attached. */
export const CLOSED_NLB_SOURCE_RANGES = ["127.0.0.1/32", "::1/128"] as const;
