/**
 * cdk8s declarations for the DevOps-agent bridges + comms bots.
 *
 * The bridge CODE lives in ../bridges/ (one shared Python image, per-bridge entrypoint).
 * This module declares how they run on the cluster: Deployments, Services (for the webhook
 * receivers), RBAC (the k8s-watch reactor needs pod/event read), and the token Secrets.
 *
 * Bridges run in the `kagent` namespace alongside the controller so the default A2A base URL
 * (`http://kagent-controller.kagent:8083`) reaches it without extra config.
 *
 * NOT wired into main.ts yet — call `declareBridges(chart, ns, opts)` once the bridge image is
 * built + pushed (ECR), passing its URI as `opts.image`. Secrets here are placeholders; in prod
 * apply real values from SOPS+AWS-KMS via `kubectl create secret` (don't bake them into dist).
 */
import { ApiObject, type ApiObjectMetadata } from "cdk8s";
import type { Construct } from "constructs";

/** Which bridges to deploy. */
export interface BridgesConfig {
  /** Bridge image, e.g. <acct>.dkr.ecr.eu-central-1.amazonaws.com/devops-bridge:v1 */
  image: string;
  /** Per-bridge enable flags (default all true if undefined). */
  enabled?: {
    k8sWatch?: boolean;
    alert?: boolean;
    github?: boolean;
    telegram?: boolean;
    matrix?: boolean;
  };
  /** Token secrets. Leave undefined to create empty placeholders (fill via kubectl/SOPS). */
  secrets?: {
    telegramBotToken?: string;
    githubToken?: string;
    githubActor?: string;
    webhookSecret?: string;
    matrixHomeserver?: string;
    matrixUser?: string;
    matrixToken?: string;
    matrixRooms?: string;
  };
  /** Public host for the GitHub webhook ingress (Phase 5). */
  githubWebhookHost?: string;
  /** TLS for the public webhook ingress (cert-manager cluster-issuer). M14: never serve the
   *  secret-bearing webhook over plain HTTP. */
  tls?: { issuer?: string };
}

const LABELS = { "app.kubernetes.io/part-of": "kagent-devops", "app.kubernetes.io/managed-by": "nebula" };

function meta(name: string, ns: string): { metadata: ApiObjectMetadata } {
  return { metadata: { name, namespace: ns, labels: LABELS } };
}

function secret(scope: Construct, id: string, name: string, ns: string, data: Record<string, string>): ApiObject {
  return new ApiObject(scope, id, {
    apiVersion: "v1",
    kind: "Secret",
    ...meta(name, ns),
    type: "Opaque",
    stringData: data,
  });
}

interface DeployOpts {
  name: string;
  ns: string;
  image: string;
  /** Container entrypoint args, e.g. ["python", "-u", "/app/k8s_watch/main.py"]. */
  args: string[];
  env?: { name: string; value?: string; secretRef?: { name: string; key: string } }[];
  ports?: { name: string; containerPort: number }[];
  serviceAccountName?: string;
  /** "Recreate" for single-consumer polling bots (Telegram/Matrix). */
  strategy?: "Recreate" | "RollingUpdate";
}

function deployment(scope: Construct, o: DeployOpts): ApiObject {
  const envList = (o.env ?? []).map((e) => {
    if (e.secretRef) return { name: e.name, valueFrom: { secretKeyRef: { name: e.secretRef.name, key: e.secretRef.key } } };
    return { name: e.name, value: e.value };
  });
  return new ApiObject(scope, o.name, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    ...meta(o.name, o.ns),
    spec: {
      replicas: 1,
      ...(o.strategy === "Recreate" ? { strategy: { type: "Recreate" } } : {}),
      selector: { matchLabels: { app: o.name } },
      template: {
        metadata: { labels: { ...LABELS, app: o.name } },
        spec: {
          ...(o.serviceAccountName ? { serviceAccountName: o.serviceAccountName } : {}),
          restartPolicy: "Always",
          containers: [
            {
              name: "bridge",
              image: o.image,
              imagePullPolicy: "IfNotPresent",
              args: o.args,
              ...(envList.length ? { env: envList } : {}),
              ...(o.ports ? { ports: o.ports } : {}),
            },
          ],
        },
      },
    },
  });
}

function service(scope: Construct, name: string, ns: string, port: number, target: string): ApiObject {
  return new ApiObject(scope, `${name}-svc`, {
    apiVersion: "v1",
    kind: "Service",
    ...meta(name, ns),
    spec: { type: "ClusterIP", selector: { app: target }, ports: [{ name: "http", port, targetPort: "http" }] },
  });
}

/** Declare all enabled bridges + their RBAC + secrets into `scope` (a Chart). */
export function declareBridges(scope: Construct, ns: string, cfg: BridgesConfig): void {
  // M13: default OFF — bridges are explicit opt-in (a token-dependent bot with an unset token
  // would crash-loop, or run with a fail-open HMAC). Set enabled.<bridge>=true to deploy it.
  const on = (k: keyof NonNullable<BridgesConfig["enabled"]>) => cfg.enabled?.[k] ?? false;
  const img = cfg.image;
  const s = cfg.secrets ?? {};

  // ── k8s-watch reactor: needs read pods/events. ────────────────────────────
  if (on("k8sWatch")) {
    new ApiObject(scope, "k8s-watch-sa", { apiVersion: "v1", kind: "ServiceAccount", ...meta("k8s-watch", ns) });
    new ApiObject(scope, "k8s-watch-role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "kagent-k8s-watch", labels: LABELS },
      rules: [
        { apiGroups: [""], resources: ["pods", "pods/log", "events"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["apps"], resources: ["deployments", "daemonsets", "statefulsets", "replicasets"], verbs: ["get", "list", "watch"] },
      ],
    });
    new ApiObject(scope, "k8s-watch-binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "kagent-k8s-watch", labels: LABELS },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "kagent-k8s-watch" },
      subjects: [{ kind: "ServiceAccount", name: "k8s-watch", namespace: ns }],
    });
    deployment(scope, {
      name: "k8s-watch", ns, image: img, serviceAccountName: "k8s-watch",
      args: ["python", "-u", "/app/k8s_watch/main.py"],
      env: [
        { name: "RESTART_THRESHOLD", value: process.env.K8S_WATCH_RESTART_THRESHOLD ?? "5" },
        { name: "COOLDOWN_SECONDS", value: process.env.K8S_WATCH_COOLDOWN ?? "300" },
        { name: "WATCH_NAMESPACES", value: process.env.K8S_WATCH_NAMESPACES ?? "" },
      ],
    });
  }

  // ── Alertmanager bridge: ClusterIP webhook receiver. ───────────────────────
  if (on("alert")) {
    deployment(scope, {
      name: "alert-bridge", ns, image: img,
      args: ["uvicorn", "alert_bridge.main:app", "--host", "0.0.0.0", "--port", "8080"],
      ports: [{ name: "http", containerPort: 8080 }],
    });
    service(scope, "alert-bridge", ns, 8080, "alert-bridge");
  }

  // ── GitHub webhook bridge: public ingress + HMAC + comment-back. ───────────
  if (on("github")) {
    const ghSecret = secret(scope, "gh-webhook-secret", "github-bridge-secrets", ns, {
      GITHUB_TOKEN: s.githubToken ?? "",
      GITHUB_ACTOR: s.githubActor ?? "",
      WEBHOOK_SECRET: s.webhookSecret ?? "",
    });
    void ghSecret;
    deployment(scope, {
      name: "github-bridge", ns, image: img,
      args: ["uvicorn", "github_bridge.main:app", "--host", "0.0.0.0", "--port", "8080"],
      ports: [{ name: "http", containerPort: 8080 }],
      env: [
        { name: "GITHUB_TOKEN", secretRef: { name: "github-bridge-secrets", key: "GITHUB_TOKEN" } },
        { name: "GITHUB_ACTOR", secretRef: { name: "github-bridge-secrets", key: "GITHUB_ACTOR" } },
        { name: "WEBHOOK_SECRET", secretRef: { name: "github-bridge-secrets", key: "WEBHOOK_SECRET" } },
      ],
    });
    service(scope, "github-bridge", ns, 8080, "github-bridge");
    if (cfg.githubWebhookHost) {
      new ApiObject(scope, "github-bridge-ingress", {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        ...meta("github-bridge", ns),
        spec: {
          ingressClassName: "nginx",
          rules: [{ host: cfg.githubWebhookHost, http: { paths: [{ path: "/github", pathType: "Prefix", backend: { service: { name: "github-bridge", port: { number: 8080 } } } }] } }],
          // M14: terminate TLS — never serve the secret-bearing webhook over plain HTTP.
          ...(cfg.tls
            ? {
                tls: [{ hosts: [cfg.githubWebhookHost], secretName: "github-bridge-tls" }],
              }
            : {}),
        },
        ...(cfg.tls
          ? { metadata: { name: "github-bridge", namespace: ns, labels: LABELS, annotations: { "cert-manager.io/cluster-issuer": cfg.tls.issuer ?? "letsencrypt-prod" } } }
          : {}),
      });
    }
  }

  // ── Telegram bot: single-consumer poller. ──────────────────────────────────
  if (on("telegram")) {
    secret(scope, "telegram-secret", "telegram-bot-secrets", ns, { TELEGRAM_BOT_TOKEN: s.telegramBotToken ?? "" });
    deployment(scope, {
      name: "telegram-bot", ns, image: img, strategy: "Recreate",
      args: ["python", "-u", "/app/telegram_bot/main.py"],
      env: [{ name: "TELEGRAM_BOT_TOKEN", secretRef: { name: "telegram-bot-secrets", key: "TELEGRAM_BOT_TOKEN" } }],
    });
  }

  // ── Matrix bot: single-consumer poller. ────────────────────────────────────
  if (on("matrix")) {
    secret(scope, "matrix-secret", "matrix-bot-secrets", ns, {
      MATRIX_HOMESERVER: s.matrixHomeserver ?? "",
      MATRIX_USER: s.matrixUser ?? "",
      MATRIX_TOKEN: s.matrixToken ?? "",
      MATRIX_ROOMS: s.matrixRooms ?? "",
    });
    deployment(scope, {
      name: "matrix-bot", ns, image: img, strategy: "Recreate",
      args: ["python", "-u", "/app/matrix_bridge/main.py"],
      env: [
        { name: "MATRIX_HOMESERVER", secretRef: { name: "matrix-bot-secrets", key: "MATRIX_HOMESERVER" } },
        { name: "MATRIX_USER", secretRef: { name: "matrix-bot-secrets", key: "MATRIX_USER" } },
        { name: "MATRIX_TOKEN", secretRef: { name: "matrix-bot-secrets", key: "MATRIX_TOKEN" } },
        { name: "MATRIX_ROOMS", secretRef: { name: "matrix-bot-secrets", key: "MATRIX_ROOMS" } },
      ],
    });
  }
}
