/** These fixed diagnostics may cross the worker boundary and reach the page.
 * Never copy parser, browser, transport or registry exception text into them:
 * those messages can contain image content, credentials or remote responses. */
const failures = {
  IMAGE_ARCHIVE_INVALID: {
    reason: "The selected file is not a supported Docker save archive, or its archive headers are damaged.",
    next: "Save one linux/amd64 image with docker image save, select the resulting uncompressed .tar file, then retry. Do not use docker export, an OCI-only archive or a compressed outer archive.",
  },
  IMAGE_DOCKER_SAVE_REQUIRED: {
    reason: "The archive has no Docker save manifest. It may be a container export or a different archive format.",
    next: "Create the archive with docker image save for one linux/amd64 image, then select that .tar file and retry.",
  },
  IMAGE_PLATFORM_UNSUPPORTED: {
    reason: "The image is not a valid linux/amd64 image. Images built for an Apple Silicon Mac may be linux/arm64.",
    next: "Build or pull the image for linux/amd64, save that image with docker image save, then select the new archive and retry.",
  },
  IMAGE_SIZE_LIMIT: {
    reason: "The image exceeds this stack's limit. Both the archive and the total uncompressed image layers must fit the displayed limit.",
    next: "Choose a smaller image. Compressed layers can expand beyond the limit even when the selected file fits.",
  },
  IMAGE_METADATA_LIMIT: {
    reason: "The image configuration or manifest exceeds the supported 1 MiB metadata limit. This is separate from the image archive size limit.",
    next: "Use an image with configuration and manifest metadata of at most 1 MiB each. Reducing layer contents alone does not reduce oversized image metadata.",
  },
  IMAGE_STORAGE_UNSUPPORTED: {
    reason: "This browser cannot provide the private local file storage required for image encryption.",
    next: "Use an up-to-date browser with private file storage enabled. Keep plaintext on your computer; do not upload it to another service as a workaround.",
  },
  IMAGE_STORAGE_QUOTA: {
    reason: "The browser ran out of local storage while saving encrypted image layers.",
    next: "Keep your recovery backup and original image, free space on your computer and allow this site's private file storage, then retry. Keep this site's owner data. The encrypted image needs local space in addition to the original archive.",
  },
  IMAGE_STORAGE_UNAVAILABLE: {
    reason: "The browser could not read the selected image or access its private encrypted-image cache.",
    next: "Keep your recovery backup and original image. Check browser storage permissions, reselect the original archive and retry; do not clear owner recovery data.",
  },
  IMAGE_CACHE_MISMATCH: {
    reason: "The saved encrypted-image cache does not match this image or release.",
    next: "Keep the latest recovery backup and select the unchanged original archive. Use Clear local ciphertext cache only to recreate this same encrypted release; do not change its keys or instance pins.",
  },
  IMAGE_INTEGRITY_FAILED: {
    reason: "The image's layer contents do not match its configuration or saved encrypted release.",
    next: "Select an intact, unchanged original image archive. If it is damaged, create a new archive from the original image; do not bypass integrity checks.",
  },
  IMAGE_WORKER_STOPPED: {
    reason: "The browser's local image-encryption worker could not start or stopped unexpectedly.",
    next: "Keep your recovery backup and original image, check available browser memory and storage, then retry with an up-to-date browser.",
  },
  IMAGE_UPLOAD_CHECKPOINT: {
    reason: "The attested upload checkpoint does not match the locally encrypted image.",
    next: "Keep the original image and recovery backup. Retry this same encrypted release; do not replace the approved policy or instance pins to accept a different checkpoint.",
  },
  IMAGE_UPLOAD_UNCONFIRMED: {
    reason: "Transfer of the encrypted image could not be confirmed. The connection or response verification failed.",
    next: "Keep your original image and recovery backup, check the connection, then retry this same release. Existing instance pins and verified upload checkpoints must be preserved.",
  },
  IMAGE_PUBLICATION_UNCONFIRMED: {
    reason: "Publication of the encrypted image could not be confirmed. The connection or response verification failed.",
    next: "Keep your original image and recovery backup, check the connection, then retry this same release. Publication may already have started; do not change its keys or instance pins.",
  },
  IMAGE_REGISTRY_SOURCE_FAILED: {
    reason: "The registry source could not be authenticated, verified or encrypted locally.",
    next: "Check the source reference, its separate registry credentials and image-decryption key, and available browser storage. Only the browser may handle source plaintext.",
  },
  IMAGE_ENCRYPTION_FAILED: {
    reason: "The browser could not finish local image encryption. No more specific safe diagnostic was available.",
    next: "Keep the original image and recovery backup, check browser storage and the selected image, then retry. If it persists, report this diagnostic code without sharing keys or passwords.",
  },
} as const;

export type ImageErrorCode = keyof typeof failures;
export class ImagePreparationError extends Error {
  readonly next: string;
  constructor(readonly code: ImageErrorCode) {
    super(failures[code].reason);
    this.next = failures[code].next;
  }
}
export function imageWorkerError(code: unknown): ImagePreparationError {
  return new ImagePreparationError(typeof code === "string" && Object.hasOwn(failures, code) ? code as ImageErrorCode : "IMAGE_ENCRYPTION_FAILED");
}

/** Exact reviewed local messages only. A substring, arbitrary error code or
 * JSON parser excerpt must never become a displayed reason. */
const reviewed = new Map<string, ImageErrorCode>();
function messages(code: ImageErrorCode, values: string[]) { for (const value of values) reviewed.set(value, code); }
messages("IMAGE_ARCHIVE_INVALID", [
  "Unsafe image archive path", "Unsupported image archive number", "Invalid image archive size",
  "Excessive image archive trailing data", "Invalid image archive ending", "Image archive header checksum differs",
  "Truncated image archive", "Invalid PAX image header", "Unsupported PAX image header", "Invalid PAX size",
  "Image archive must contain regular files, not links or special files", "Duplicate or excessive image archive entries",
  "Image archive has no complete end marker", "Choose an archive containing exactly one image", "Image configuration is missing",
  "An image layer is missing", "Invalid gzip image layer header",
]);
messages("IMAGE_DOCKER_SAVE_REQUIRED", ["Choose a Docker save image archive containing manifest.json"]);
messages("IMAGE_PLATFORM_UNSUPPORTED", ["A valid linux/amd64 image is required", "A valid bounded linux/amd64 image is required"]);
messages("IMAGE_SIZE_LIMIT", [
  "The image archive exceeds this stack's upload limit", "Uncompressed image layers exceed this stack's upload limit",
  "Encrypted layers exceed this stack's upload limit",
]);
messages("IMAGE_METADATA_LIMIT", ["Image metadata exceeds 1 MiB", "Encrypted image metadata exceeds 1 MiB"]);
messages("IMAGE_STORAGE_UNSUPPORTED", ["This browser needs private file storage for large-image encryption"]);
messages("IMAGE_CACHE_MISMATCH", [
  "This encrypted cache belongs to another image or owner", "The local encrypted manifest changed",
  "The saved ciphertext is missing. Restore the latest encrypted recovery backup and select the original archive",
  "Invalid encrypted cache path", "The encrypted image cache is incomplete", "The local encrypted image is incomplete",
  "Invalid local ciphertext cache identity", "Encrypted recovery metadata differs from the original image",
  "Encrypted recovery layer layout differs", "Encrypted recovery layer differs", "Encrypted recovery key binding differs",
  "Encrypted recovery parameters differ", "Recovered image size differs", "Recovered encrypted manifest differs",
]);
messages("IMAGE_INTEGRITY_FAILED", [
  "Choose the unchanged original archive to recover this encrypted release", "Image layer size differs",
  "Image layer content differs from its configuration", "Regenerated ciphertext differs from the encrypted recovery manifest",
  "Invalid local encrypted layer",
]);
messages("IMAGE_UPLOAD_CHECKPOINT", ["The attested upload checkpoint differs from your encrypted image", "Invalid attested encrypted-layer checkpoint"]);

export function classifyImageError(error: unknown): ImagePreparationError {
  if (error instanceof ImagePreparationError) return error;
  let name: unknown, message: unknown;
  try {
    name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
    message = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
  } catch { /* Getters and unusual exceptions retain the fixed fallback. */ }
  if (name === "QuotaExceededError") return new ImagePreparationError("IMAGE_STORAGE_QUOTA");
  if (["NotAllowedError", "SecurityError", "NotReadableError", "NotFoundError", "InvalidStateError", "NoModificationAllowedError"].includes(name as string)) {
    return new ImagePreparationError("IMAGE_STORAGE_UNAVAILABLE");
  }
  return new ImagePreparationError(typeof message === "string" ? reviewed.get(message) ?? "IMAGE_ENCRYPTION_FAILED" : "IMAGE_ENCRYPTION_FAILED");
}
