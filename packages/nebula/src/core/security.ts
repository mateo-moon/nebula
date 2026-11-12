import type { PodSecurityContext, SecurityContext } from "cdk8s-plus-33/lib/imports/k8s";

/** A Pod running as one unprivileged user and group under the default seccomp profile. */
export const unprivilegedPod = (id = 65532): PodSecurityContext => ({
  runAsNonRoot: true, runAsUser: id, runAsGroup: id, fsGroup: id, seccompProfile: { type: "RuntimeDefault" },
});

/** A container without privilege escalation, capabilities or a writable root filesystem. */
export const confinedContainer: SecurityContext = {
  allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] },
};
