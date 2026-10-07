/**
 * Scheduled EBS snapshots via Data Lifecycle Manager.
 *
 * DLM rather than AWS Backup: this is EBS-only, tag-targeted, needs no vault,
 * and the schedule is the whole feature. AWS Backup earns its extra surface
 * (vaults, restore testing, cross-account) only once there is something other
 * than EBS to protect.
 *
 * Snapshots are crash-consistent, not application-consistent — DLM does not
 * quiesce the filesystem. That is the right trade for data whose application
 * replays its WAL on start and is NOT a substitute for an etcd backup, which
 * needs `k0s etcd backup` semantics rather than a block-level copy.
 */
import { Construct } from "constructs";
import {
  Role as CpRole,
  RolePolicyAttachment as CpRolePolicyAttachment,
} from "#imports/iam.aws.upbound.io";
import { LifecyclePolicyV1Beta2 } from "#imports/dlm.aws.upbound.io";

/** DLM assumes this role to create and delete snapshots on your behalf. */
const DLM_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "dlm.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

const DLM_SERVICE_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole";

/** DLM accepts only these create intervals (hours). */
const VALID_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];

export interface DlmSnapshotSchedule {
  /** Schedule id. The LifecyclePolicy MR is named `<config.name>-<name>`, so
   *  this is also how an existing policy is adopted without churn. */
  name: string;
  /** Existing LifecyclePolicy MR name (default `<config.name>-<name>`).
   * Preserve this independently of the AWS schedule name during adoption. */
  resourceName?: string;
  /**
   * DLM's own name for the schedule (default: {@link name}).
   *
   * Distinct from the MR name because DLM stamps it onto every snapshot as
   * `aws:dlm:lifecycle-schedule-name` and applies retention PER SCHEDULE
   * NAME: renaming it strands the snapshots taken under the old name outside
   * the retain count, so they are never pruned. Set this when adopting a
   * policy whose schedule is already producing snapshots.
   */
  scheduleName?: string;
  /** DLM policy description. AWS restricts these to `[0-9A-Za-z _-]` — no
   *  punctuation. Defaults to the MR name, which is rarely what a human
   *  reading the AWS console wants. */
  description?: string;
  region: string;
  /**
   * Volumes carrying ANY of these exact key/value pairs are snapshotted.
   * Use one constant marker tag to select a fleet; adding tags broadens scope.
   * https://docs.aws.amazon.com/ebs/latest/userguide/dlm-elements.html
   */
  targetTags: Record<string, string>;
  /** Hours between snapshots — one of 1,2,3,4,6,8,12,24 (default 24). */
  intervalHours?: number;
  /** UTC start times, "HH:MM" (default ["03:00"] — off-peak for EU/NA/ASIA). */
  times?: string[];
  /** How many snapshots to keep (default 7). */
  retain?: number;
  /**
   * Copy the volume's tags onto the snapshot (default true). Without this a
   * restore cannot tell which node a snapshot came from — the tags are the
   * only identity a snapshot carries.
   */
  copyTags?: boolean;
}

export interface AwsDlmConfig {
  /** Resource-name prefix, e.g. "stage". */
  name: string;
  /** Execution-role name (default `<name>-dlm-role`). Set it to adopt a role
   *  that already exists — the MR keeps its name, so nothing is recreated. */
  roleName?: string;
  /** AWS role binding (default roleName). Null leaves the provider-owned
   * external-name annotation unmanaged when adopting an existing MR. */
  roleExternalName?: string | null;
  /** Execution-role description. Null preserves an existing unmanaged value. */
  roleDescription?: string | null;
  schedules: DlmSnapshotSchedule[];
  /** Crossplane ProviderConfig (default "default"). */
  providerConfigRef?: string;
  /** Extra resource tags, including the default nebula.sh/role=dlm marker.
   * Null omits desired tags entirely when adopting untagged resources. */
  tags?: Record<string, string> | null;
}

/**
 * One shared DLM execution role plus a LifecyclePolicy per schedule.
 *
 * The role is shared because DLM's permissions are identical for every policy
 * (create/delete snapshot, describe volumes) and AWS's own default role is a
 * singleton per account — a role per schedule would be noise with no isolation
 * benefit.
 */
export class AwsDlm extends Construct {
  /** AWS name of the DLM execution role. */
  public readonly roleName: string;

  constructor(scope: Construct, id: string, config: AwsDlmConfig) {
    super(scope, id);

    const providerConfigRef = { name: config.providerConfigRef ?? "default" };
    this.roleName = config.roleName ?? `${config.name}-dlm-role`;
    const tags = config.tags === null ? undefined : { ...config.tags, "nebula.sh/role": "dlm" };
    const roleExternalName = config.roleExternalName === undefined ? this.roleName : config.roleExternalName;
    const roleDescription = config.roleDescription === undefined
      ? "Nebula EBS snapshot lifecycle (DLM) execution role" : config.roleDescription;

    // Deterministic AWS name via external-name, matching AwsIam: the policies
    // below reference the role by name, so a generated name would not resolve.
    new CpRole(this, "dlm-role", {
      metadata: {
        name: this.roleName,
        ...(roleExternalName === null ? {} : { annotations: { "crossplane.io/external-name": roleExternalName } }),
      },
      spec: {
        forProvider: {
          assumeRolePolicy: DLM_ASSUME_ROLE_POLICY,
          ...(roleDescription === null ? {} : { description: roleDescription }),
          tags,
        },
        providerConfigRef,
      },
    });

    new CpRolePolicyAttachment(this, "dlm-role-policy", {
      // Derived from the role, not the prefix, so adopting a role adopts its
      // attachment too — a differently-named MR here would detach and
      // reattach the policy on the live role.
      metadata: { name: `${this.roleName}-service` },
      spec: {
        forProvider: {
          policyArn: DLM_SERVICE_POLICY_ARN,
          roleRef: { name: this.roleName },
        },
        providerConfigRef,
      },
    });

    const resourceNames = new Set<string>();
    for (const s of config.schedules) {
      const resourceName = s.resourceName ?? `${config.name}-${s.name}`;
      if (resourceNames.has(resourceName)) {
        throw new Error(`DLM schedule "${s.name}": duplicate resourceName "${resourceName}"`);
      }
      resourceNames.add(resourceName);
      const interval = s.intervalHours ?? 24;
      if (!VALID_INTERVALS.includes(interval)) {
        throw new Error(
          `DLM schedule "${s.name}": intervalHours must be one of ` +
            `${VALID_INTERVALS.join(", ")} (got ${interval})`,
        );
      }
      const description = s.description ?? resourceName;
      if (!/^[0-9A-Za-z _-]*$/.test(description)) {
        // DLM rejects anything else, and the API error names the field but
        // not the offending character.
        throw new Error(
          `DLM schedule "${s.name}": description must match [0-9A-Za-z _-] ` +
            `(got "${description}")`,
        );
      }
      if (Object.keys(s.targetTags).length === 0) {
        // An empty target set matches every volume in the region, which is a
        // silent way to snapshot the entire estate on a schedule.
        throw new Error(`DLM schedule "${s.name}": targetTags must not be empty`);
      }

      new LifecyclePolicyV1Beta2(this, `dlm-${s.name}`, {
        metadata: { name: resourceName },
        spec: {
          forProvider: {
            region: s.region,
            description,
            executionRoleArnRef: { name: this.roleName },
            state: "ENABLED",
            tags,
            policyDetails: {
              policyType: "EBS_SNAPSHOT_MANAGEMENT",
              resourceTypes: ["VOLUME"],
              targetTags: s.targetTags,
              schedule: [
                {
                  name: s.scheduleName ?? s.name,
                  copyTags: s.copyTags ?? true,
                  createRule: {
                    interval,
                    intervalUnit: "HOURS",
                    times: s.times ?? ["03:00"],
                  },
                  retainRule: { count: s.retain ?? 7 },
                },
              ],
            },
          },
          providerConfigRef,
        },
      });
    }
  }
}
