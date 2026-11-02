const MiB = 1024 * 1024;
export interface ImageUploadLimits { maxBytes: number; chunkBytes: number; jobTimeoutMs: number }

export function imageUploadLimits(maxImageSizeMiB = 256): ImageUploadLimits {
  if (!Number.isInteger(maxImageSizeMiB) || maxImageSizeMiB < 1 || maxImageSizeMiB > 4096) {
    throw new Error("Image archive limit must be between 1 and 4096 MiB");
  }
  return { maxBytes: maxImageSizeMiB * MiB, chunkBytes: 8 * MiB,
    jobTimeoutMs: maxImageSizeMiB <= 256 ? 900_000 : 7_200_000 };
}

export function checkedImageUploadLimits(value: unknown): ImageUploadLimits {
  const supplied = value as ImageUploadLimits | undefined;
  if (!supplied || Object.keys(supplied).sort().join() !== "chunkBytes,jobTimeoutMs,maxBytes") throw new Error("Invalid attested image limits");
  const expected = imageUploadLimits(supplied.maxBytes / MiB);
  if (expected.chunkBytes !== supplied.chunkBytes || expected.jobTimeoutMs !== supplied.jobTimeoutMs) throw new Error("Invalid attested image limits");
  return expected;
}

export function imageSizeLabel(bytes: number) {
  return bytes >= 1024 * MiB ? `${Number((bytes / (1024 * MiB)).toFixed(2))} GiB` : `${Number((bytes / MiB).toFixed(1))} MiB`;
}
