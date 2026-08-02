/**
 * Hourly AWS orphan-instance sweep — the UNCORRELATED backstop for the
 * duplicate-create window that survives every in-band fix.
 *
 * Why it exists: a Crossplane provider hard-killed between RunInstances and
 * the external-name write leaks an instance the control plane has never heard
 * of (terraform's aws_instance sets no idempotency token; the crossplane-side
 * fix, crossplane-runtime#850, is still open). Observed live 2026-08-02: a
 * starving node killed provider-aws-ec2 mid-spot-recreate → two orphan
 * m6i.2xlarge burning for 9 hours. The in-band alerts were blind because the
 * monitoring hub was down for the SAME root cause — the backstop must diff
 * AWS reality against cluster records from outside that failure domain.
 *
 * Mechanics: a CronJob on the management cluster. An init container snapshots
 * the cluster's known instance identities (worker-fleet Instance MR
 * external-names + every CAPI Machine providerID); the main container assumes
 * the NODE ROLE via IMDS (the keyless model — no mounted credentials) and
 * walks the fleet regions. Only instances carrying the fleet's purpose tag
 * are judged:
 *   - id known to the cluster            → fine.
 *   - Name tag matches an Instance MR whose external-name is a DIFFERENT id,
 *     older than minAgeMinutes, and not EIP-associated
 *                                        → the exact duplicate signature:
 *                                          TERMINATED (unless dryRun).
 *   - anything else unexpected           → reported only.
 * Any finding (including a termination it performed) fails the Job, so the
 * stock KubeJobFailed alerting announces it; the next clean hourly run
 * auto-resolves.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

export interface AwsOrphanSweepConfig {
  /** Namespace for the CronJob + ServiceAccount. */
  namespace: string;
  /** Regions to sweep (the fleet's regions). */
  regions: string[];
  /** Tag key marking fleet-owned instances (e.g. "nuconstruct.io/purpose").
   *  Instances without it are never judged. */
  purposeTagKey: string;
  /** Cron schedule (default hourly at :17). */
  schedule?: string;
  /** Duplicates younger than this are left alone — a create might still be
   *  mid-adoption (default 30). */
  minAgeMinutes?: number;
  /** Report-only mode: log the terminate decision, do nothing. */
  dryRun?: boolean;
  /** Image with kubectl for the snapshot init container. */
  kubectlImage?: string;
  /** Image with the AWS CLI for the sweep container. */
  awsCliImage?: string;
}

const SNAPSHOT_SCRIPT = `set -eu
kubectl get instances.ec2.aws.upbound.io \\
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.crossplane\\.io/external-name}{"\\n"}{end}' \\
  > /shared/mr-map.txt
kubectl get machines.cluster.x-k8s.io -A \\
  -o jsonpath='{range .items[*]}{.spec.providerID}{"\\n"}{end}' \\
  | grep -o 'i-[0-9a-f]*' > /shared/machine-ids.txt || true
echo "snapshot: $(wc -l < /shared/mr-map.txt) MRs, $(wc -l < /shared/machine-ids.txt) machine ids"
`;

const SWEEP_SCRIPT = `set -u
FINDINGS=0
NOW=$(date +%s)
for R in $REGIONS; do
  aws ec2 describe-instances --region "$R" \\
    --filters Name=instance-state-name,Values=running,pending "Name=tag-key,Values=$PURPOSE_TAG" \\
    --query 'Reservations[].Instances[].[InstanceId,LaunchTime,Tags[?Key==\`Name\`]|[0].Value]' \\
    --output text > /tmp/live.txt || { echo "describe-instances failed in $R"; FINDINGS=$((FINDINGS+1)); continue; }
  while read -r ID LAUNCH NAME; do
    [ -z "$ID" ] && continue
    grep -q "^$ID$" /shared/machine-ids.txt && continue
    grep -q " $ID$" /shared/mr-map.txt && continue
    AGE_MIN=$(( (NOW - $(date -d "$LAUNCH" +%s)) / 60 ))
    if grep -q "^$NAME " /shared/mr-map.txt && [ "$AGE_MIN" -ge "$MIN_AGE_MIN" ]; then
      ASSOC=$(aws ec2 describe-addresses --region "$R" --filters Name=instance-id,Values="$ID" \\
        --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "query-failed")
      if [ "$ASSOC" = "None" ]; then
        FINDINGS=$((FINDINGS+1))
        if [ "$DRY_RUN" = "true" ]; then
          echo "DUPLICATE (dry-run, would terminate): $R $ID name=$NAME age=\${AGE_MIN}m"
        else
          echo "DUPLICATE: terminating $R $ID name=$NAME age=\${AGE_MIN}m"
          aws ec2 terminate-instances --region "$R" --instance-ids "$ID" >/dev/null \\
            || echo "terminate FAILED for $ID"
        fi
        continue
      fi
    fi
    FINDINGS=$((FINDINGS+1))
    echo "UNKNOWN fleet-tagged instance (report only): $R $ID name=$NAME age=\${AGE_MIN}m"
  done < /tmp/live.txt
done
[ "$FINDINGS" -gt 0 ] && { echo "$FINDINGS finding(s) — failing the Job so KubeJobFailed announces it"; exit 1; }
echo "clean sweep"
`;

export class AwsOrphanSweep extends Construct {
  constructor(scope: Construct, id: string, config: AwsOrphanSweepConfig) {
    super(scope, id);
    const ns = config.namespace;
    const name = "aws-orphan-sweep";

    new ApiObject(this, "sa", {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name, namespace: ns },
    });
    new ApiObject(this, "role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name },
      rules: [
        {
          apiGroups: ["ec2.aws.upbound.io"],
          resources: ["instances"],
          verbs: ["get", "list"],
        },
        {
          apiGroups: ["cluster.x-k8s.io"],
          resources: ["machines"],
          verbs: ["get", "list"],
        },
      ],
    });
    new ApiObject(this, "binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name },
      subjects: [{ kind: "ServiceAccount", name, namespace: ns }],
    });

    new ApiObject(this, "cronjob", {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name, namespace: ns },
      spec: {
        schedule: config.schedule ?? "17 * * * *",
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 1,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: 600,
            template: {
              spec: {
                serviceAccountName: name,
                restartPolicy: "Never",
                volumes: [{ name: "shared", emptyDir: {} }],
                initContainers: [
                  {
                    name: "snapshot",
                    image: config.kubectlImage ?? "bitnami/kubectl:1.33",
                    command: ["sh", "-c", SNAPSHOT_SCRIPT],
                    volumeMounts: [{ name: "shared", mountPath: "/shared" }],
                  },
                ],
                containers: [
                  {
                    name: "sweep",
                    image:
                      config.awsCliImage ??
                      "public.ecr.aws/aws-cli/aws-cli:latest",
                    command: ["bash", "-c", SWEEP_SCRIPT],
                    env: [
                      { name: "REGIONS", value: config.regions.join(" ") },
                      { name: "PURPOSE_TAG", value: config.purposeTagKey },
                      {
                        name: "MIN_AGE_MIN",
                        value: String(config.minAgeMinutes ?? 30),
                      },
                      { name: "DRY_RUN", value: String(config.dryRun ?? false) },
                    ],
                    volumeMounts: [{ name: "shared", mountPath: "/shared" }],
                    resources: {
                      requests: { cpu: "50m", memory: "64Mi" },
                      limits: { memory: "256Mi" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
  }
}
