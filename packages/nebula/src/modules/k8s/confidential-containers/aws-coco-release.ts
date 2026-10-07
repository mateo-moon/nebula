import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { digest, object, requireValue } from "./aws-signatures";

export interface AwsCocoProfile {
  readonly release: string;
  readonly role: "authority" | "runtime";
  readonly pcr4: string;
  readonly pcr12: string;
  readonly minimumTcb: { readonly bootloader: number; readonly tee: number; readonly snp: number; readonly microcode: number };
}
export interface AwsCocoArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly compressedSize: number;
  readonly rawSha256: string;
  readonly rawSize: number;
}
export interface AwsCocoRelease {
  readonly version: 1;
  readonly id: string;
  readonly authority: { readonly profile: AwsCocoProfile; readonly artifact: AwsCocoArtifact };
  readonly runtime: { readonly profile: AwsCocoProfile; readonly artifact: AwsCocoArtifact };
  readonly controllerImage: string;
  readonly caaImage: string;
  readonly cleanupImage: string;
  readonly clients: Readonly<Record<string, { readonly url: string; readonly sha256: string; readonly size: number }>>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function awsCocoProfileId(profile: Omit<AwsCocoProfile, "release">): string {
  return hash(JSON.stringify({ minimumTcb: { bootloader: profile.minimumTcb.bootloader, tee: profile.minimumTcb.tee,
    snp: profile.minimumTcb.snp, microcode: profile.minimumTcb.microcode }, pcr4: profile.pcr4, pcr12: profile.pcr12, role: profile.role, version: 1 }));
}
export function validateAwsCocoRelease(release: AwsCocoRelease): void {
  object(release, ["version", "id", "authority", "runtime", "controllerImage", "caaImage", "cleanupImage", "clients"], "CoCo release");
  requireValue(release.version === 1 && digest(release.id), "invalid CoCo release");
  for (const role of ["authority", "runtime"] as const) {
    const { profile, artifact } = release[role];
    object(profile, ["release", "role", "pcr4", "pcr12", "minimumTcb"], "release profile");
    object(profile.minimumTcb, ["bootloader", "tee", "snp", "microcode"], "TCB policy");
    // AWS's UKI tool expects the reset value in PCR12 when no external boot
    // parameters were supplied. It is still pinned and compared exactly.
    requireValue(profile.role === role && [profile.pcr4, profile.pcr12].every(pcr => /^[a-f0-9]{96}$/.test(pcr)) &&
      !/^0+$/.test(profile.pcr4) &&
      Object.values(profile.minimumTcb).every(value => Number.isInteger(value) && value >= 0 && value <= 255) &&
      profile.minimumTcb.bootloader > 0 && profile.minimumTcb.microcode > 0 &&
      profile.minimumTcb.snp >= 27 && awsCocoProfileId(profile) === profile.release, "release profile commitment mismatch");
    requireValue(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(artifact.url) &&
      digest(artifact.sha256) && digest(artifact.rawSha256) && Number.isSafeInteger(artifact.compressedSize) &&
      artifact.compressedSize > 0 && artifact.compressedSize <= 2 * 1024 ** 3 && Number.isSafeInteger(artifact.rawSize) &&
      artifact.rawSize > 0 && artifact.rawSize <= 16 * 1024 ** 3, "invalid released disk artifact");
  }
  requireValue(release.id === hash(`${release.authority.profile.release}\n${release.runtime.profile.release}\n`), "release pair commitment mismatch");
  for (const image of [release.controllerImage, release.caaImage, release.cleanupImage]) {
    requireValue(/^(ghcr\.io|quay\.io)\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/.test(image), "digest-pinned controller images required");
  }
  requireValue(Object.keys(release.clients).length > 0, "attested publisher clients required");
  for (const [platform, artifact] of Object.entries(release.clients)) {
    requireValue(["linux-x64", "darwin-arm64", "darwin-x64"].includes(platform) &&
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(artifact.url) && digest(artifact.sha256) &&
      Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size < 128 * 1024 ** 2, "invalid publisher client artifact");
  }
}

/** The authenticated package pins released bytes and build-derived PCRs. No
 * AWS calls, live measurement enrollment, or network access during synthesis. */
export function awsCocoRelease(): AwsCocoRelease {
  const release = JSON.parse(readFileSync(new URL("./aws-nitrotpm/release/catalog.json", import.meta.url), "utf8")) as AwsCocoRelease;
  validateAwsCocoRelease(release);
  return release;
}
