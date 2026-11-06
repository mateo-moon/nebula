/** Reviewed upstream Trustee Helm package. Changing this package changes the
 * measured guest and requires a new owner approval and enrollment. A tenant
 * declaration must never select a Helm source or pass Helm flags. */
export const TRUSTEE_CHART = "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5";
export const TRUSTEE_CHART_VERSION = "0.21.0";
