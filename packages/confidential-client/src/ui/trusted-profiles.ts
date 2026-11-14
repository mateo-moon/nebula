import type { ConfidentialConnection } from "./connection";

/** Runtime release trust is installed with this client, never learned from the
 * stack asking for keys. The first profile is the current release. Older
 * records remain historical references; new bindings never select them.
 * Existing owners recover through their original preparation release, bound
 * by the loader's saved instance pin and the original owner's signature.
 * Application behavior still needs separate applicationContract approval. */
const ACCESS_PROFILE = {
  agentImage: undefined as string | undefined,
  id: "nebula-snp-access-2026-10",
  measurement: "e6bfc24840176237937ab32b8a9425fae4856b03a7864efea46e92b9c5b4a76eef48e889f498fceb73c90e03dcb8bcd9",
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 },
  chart: "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5",
  kbsImage: "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68",
  tngImage: "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416",
  gatewayImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:5b32e3c52c94747019c24c2fd8fb3de0ce823374bb9fdad20fc9c4c7ea5cf074",
  storageImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:4d6bd8371595c90eb309099171c2c00d9051ad300663339305678de6ee931fbd",
} as const;
export const TRUSTED_STACKS = [{ ...ACCESS_PROFILE, id: "nebula-snp-agent-hardening-2026-11-14",
  measurement: "8c33e7ed240da6571f04802dd97050d4a8ce029473931dce869ee458b1dfd7025745ed62e7391fea520db139332c0c8e",
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 },
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:21908d1a279697b6de6f54896074be1657ffd543cb450af873826d5cf00c4553",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}, ACCESS_PROFILE, { ...ACCESS_PROFILE, id: "nebula-snp-browser-2026-10",
  gatewayImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:eb1b8d91dbc0729d7f0b901e7d0e8c036be3b02bd0905788fdd53b86d9031318",
}, { ...ACCESS_PROFILE, id: "nebula-snp-browser-tested-2026-10-28",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:104fce8e85559258eb54787d3e837a2b0e858ee9009a886ff58cb43fb91f72dc",
  gatewayImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:d732ff99a900f6100fbd50392aa4cafc4226cd2389d6d3c9d9a4752f374bd410",
}, { ...ACCESS_PROFILE, id: "nebula-snp-agent-2026-11-04",
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:796df4b0f2994e3e244b9ab564183deb00c02570aab27b0777b3c1dcb530e7ff",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}, { ...ACCESS_PROFILE, id: "nebula-snp-agent-bootstrap-2026-11-04",
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:34b8c7f5b1dd5d890b1ac6e1b00f4bd6e9dc2027e67641a4fc2735bcb911e1d2",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}, { ...ACCESS_PROFILE, id: "nebula-snp-agent-owner-gate-2026-11-06",
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:f598d046078b10066d260f2bd4fb7edcbd1e9ae020f8967a97d5b47f1e350797",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}, { ...ACCESS_PROFILE, id: "nebula-snp-agent-reporting-2026-11-12",
  measurement: "8c33e7ed240da6571f04802dd97050d4a8ce029473931dce869ee458b1dfd7025745ed62e7391fea520db139332c0c8e",
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 },
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:0a3537ec5872def11f694b7d9f467cd91fcea27fc36533cfe1f1f1304407ce89",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}, { ...ACCESS_PROFILE, id: "nebula-snp-agent-collateral-2026-11-13",
  measurement: "8c33e7ed240da6571f04802dd97050d4a8ce029473931dce869ee458b1dfd7025745ed62e7391fea520db139332c0c8e",
  minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 84 },
  agentImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:6f640db9370a5a42a218ab064d825304a0755986498739bd632189aef42e09c8",
  tngImage: "ghcr.io/mateo-moon/nebula-coco-canary@sha256:111286414faa8505162bcdc861046f1428c9b7ef832b583bf220d9ce68932029",
  gatewayImage: undefined,
  storageImage: undefined,
}] as const;

export function trustedStack(connection: ConfidentialConnection): string {
  const spec = connection.workload.spec;
  if (spec.containers.length !== 1 || !spec.containers[0].imageKeyResource) {
    throw new Error("Automatic discovery requires one owner-encrypted application; undeclared sidecars are not trusted");
  }
  const profile = TRUSTED_STACKS[0];
  const matches = profile.measurement === spec.guest.measurement &&
    profile.chart === spec.trustee.chart && profile.kbsImage === spec.trustee.kbsImage &&
    profile.tngImage === spec.trustee.tngImage && profile.gatewayImage === spec.trustee.gatewayImage &&
    profile.storageImage === spec.storageImage && profile.agentImage === spec.agentImage &&
    Object.entries(profile.minimumReportedTcb).every(([field, value]) =>
      spec.guest.minimumReportedTcb[field as keyof typeof profile.minimumReportedTcb] >= value);
  if (!matches) throw new Error("This stack does not match the current reviewed profile installed with this client. No keys were released; install the matching reviewed client release");
  return profile.id;
}
