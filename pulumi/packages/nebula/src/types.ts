/**
 * Nebula type definitions
 * 
 * This file exports only types, no runtime code.
 * Safe to import without triggering Pulumi side effects.
 */

export interface NebulaConfig {
  /** Environment/stack name (e.g., 'dev', 'prod') */
  env: string;
  /** Pulumi backend URL (e.g., gs://my-bucket, s3://my-bucket) */
  backendUrl: string;
  /** Secrets provider URL (e.g., gcpkms://..., awskms://...) */
  secretsProvider?: string;
  /** GCP project ID */
  gcpProject?: string;
  /** GCP region */
  gcpRegion?: string;
  /** Domain for services (e.g., 'dev.example.com') */
  domain?: string;
}
