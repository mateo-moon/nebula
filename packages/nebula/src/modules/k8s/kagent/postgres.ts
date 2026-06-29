/**
 * External ephemeral Postgres for kagent (emptyDir) — the bare-cluster storage workaround.
 *
 * The kagent chart's bundled Postgres always creates a PVC (`postgres.bundled.*` has no
 * persistence-disable toggle), and a bare k0s cluster may have no working StorageClass
 * (e.g. EBS-CSI needs node-role EBS perms that aren't granted on a test bootstrap). So we
 * run an external Postgres on emptyDir and point kagent at it via the `Kagent` construct's
 * `externalPostgres: { url, vectorEnabled }` (with `postgres.bundled.enabled:false`).
 *
 * Uses the `pgvector/pgvector:pg16` image so the vector extension kagent's long-term memory
 * needs is available out of the box — pass `vectorEnabled: true` on the `Kagent` construct so
 * the controller runs its pgvector migration.
 *
 * Dev/eval only — data is lost on pod restart. Production uses CloudNativePG on EBS.
 *
 * Usage:
 * ```ts
 * new Kagent(chart, 'kagent', {
 *   externalPostgres: { url: KAGENT_PG_URL, vectorEnabled: true },
 * });
 * declareExternalPostgres(chart, 'kagent');
 * ```
 */
import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";

const LABELS = {
  "app.kubernetes.io/part-of": "kagent-devops",
  "app.kubernetes.io/managed-by": "nebula",
};

/**
 * Connection string kagent uses (db/user/pass all "kagent", matching the chart's bundled
 * defaults). Pass this to `KagentConfig.externalPostgres.url`.
 */
export const KAGENT_PG_URL =
  "postgresql://kagent:kagent@kagent-pg.kagent:5432/kagent";

export interface ExternalPostgresOptions {
  /** Postgres image (default `pgvector/pgvector:pg16` — ships the vector extension). */
  image?: string;
  /** Postgres DB name (default "kagent"). */
  database?: string;
  /** Postgres user (default "kagent"). */
  user?: string;
  /** Postgres password (default "kagent"). */
  password?: string;
}

/**
 * Declare the external Postgres Deployment + Service. Returns the Service name
 * (`kagent-pg`). The connection string is {@link KAGENT_PG_URL}.
 */
export function declareExternalPostgres(
  scope: Construct,
  ns: string,
  opts: ExternalPostgresOptions = {},
): string {
  const name = "kagent-pg";
  const image = opts.image ?? "pgvector/pgvector:pg16";
  const db = opts.database ?? "kagent";
  const user = opts.user ?? "kagent";
  const password = opts.password ?? "kagent";
  new ApiObject(scope, "ext-postgres", {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels: LABELS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { ...LABELS, app: name } },
        spec: {
          // The official postgres image runs as the non-root `postgres` user and can't
          // init a root-owned emptyDir — chown the data dir first (uid-agnostic, by name).
          initContainers: [
            {
              name: "chown-data",
              image,
              command: [
                "chown",
                "-R",
                "postgres:postgres",
                "/var/lib/postgresql/data",
              ],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/postgresql/data" },
              ],
              securityContext: { runAsUser: 0 },
            },
          ],
          containers: [
            {
              name: "postgres",
              image,
              env: [
                { name: "POSTGRES_DB", value: db },
                { name: "POSTGRES_USER", value: user },
                { name: "POSTGRES_PASSWORD", value: password },
              ],
              ports: [{ containerPort: 5432 }],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/postgresql/data" },
              ],
            },
          ],
          volumes: [{ name: "data", emptyDir: {} }],
        },
      },
    },
  });
  new ApiObject(scope, "ext-postgres-svc", {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns, labels: LABELS },
    spec: {
      type: "ClusterIP",
      selector: { app: name },
      ports: [{ port: 5432, targetPort: 5432 }],
    },
  });
  return name;
}
