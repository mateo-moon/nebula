import type { ConfidentialConnection } from "./connection";

/** Release trust is installed with this client, never learned from the stack
 * that is asking for keys. A new measured runtime needs a reviewed release. */
const ACCESS_PROFILE = {
  id: "nebula-snp-access-2026-10",
  measurement: "e6bfc24840176237937ab32b8a9425fae4856b03a7864efea46e92b9c5b4a76eef48e889f498fceb73c90e03dcb8bcd9",
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 },
  chart: "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5",
  kbsImage: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
  tngImage: "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416",
  gatewayImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:5b32e3c52c94747019c24c2fd8fb3de0ce823374bb9fdad20fc9c4c7ea5cf074",
  storageImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:4d6bd8371595c90eb309099171c2c00d9051ad300663339305678de6ee931fbd",
} as const;
export const TRUSTED_STACKS = [ACCESS_PROFILE, { ...ACCESS_PROFILE, id: "nebula-snp-browser-2026-10",
  gatewayImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:071b9ef9dc86c0275ffcc5cdc256ad3b87d41a42536c305855061876185827d7",
}] as const;

export function trustedStack(connection: ConfidentialConnection): string {
  const spec = connection.workload.spec;
  if (spec.containers.length !== 1 || !spec.containers[0].imageKeyResource) {
    throw new Error("Automatic discovery requires one owner-encrypted application; undeclared sidecars are not trusted");
  }
  const match = TRUSTED_STACKS.find(profile => profile.measurement === spec.guest.measurement &&
    profile.chart === spec.trustee.chart && profile.kbsImage === spec.trustee.kbsImage &&
    profile.tngImage === spec.trustee.tngImage && profile.gatewayImage === spec.trustee.gatewayImage &&
    profile.storageImage === spec.storageImage &&
    Object.entries(profile.minimumReportedTcb).every(([field, value]) =>
      spec.guest.minimumReportedTcb[field as keyof typeof profile.minimumReportedTcb] >= value));
  if (!match) throw new Error("This stack does not match a reviewed profile installed with this client. No keys were released; install the matching reviewed client release");
  return match.id;
}
