/** OCIcrypt metadata shared by the browser and ciphertext-only publisher. */
export const KEY_ANNOTATION = "org.opencontainers.image.enc.keys.provider.attestation-agent";
export const PUBLIC_ANNOTATION = "org.opencontainers.image.enc.pubopts";
export const LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+encrypted";
export const MAX_METADATA_BYTES = 1024 * 1024;
export interface EncryptedImageMetadata { version: 2; manifest: string; config: string }
export interface EncryptedLayer { mediaType: string; digest: string; size: number; annotations: Record<string, string> }
export interface EncryptedManifest {
  schemaVersion: 2; mediaType: string;
  config: { mediaType: string; digest: string; size: number };
  layers: EncryptedLayer[];
}
