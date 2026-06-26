import { Construct } from "constructs";
import {
  Role as CpRole,
  RolePolicyAttachment as CpRolePolicyAttachment,
  InstanceProfile as CpInstanceProfile,
} from "#imports/iam.aws.upbound.io";

/** EC2 instance trust policy for the worker node role. */
const EC2_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

/** Default CAPA node instance-profile name (what AWSMachine looks up by default). */
export const DEFAULT_NODE_INSTANCE_PROFILE =
  "nodes.cluster-api-provider-aws.sigs.k8s.io";

/**
 * Coarse "mgmt controller" permission set, attached to the node role as an INLINE
 * policy when `controllerPolicies` is set. This is what makes the management
 * cluster KEYLESS: its Crossplane provider-aws and CAPA controllers run on these
 * nodes and pick up the role via the instance profile (IMDS / default AWS SDK
 * chain), so no static AWS keys are baked on the cluster.
 *
 * Service-level wildcards (not the verbose clusterawsadm/Crossplane scoped
 * policies) keep this small enough for a single inline policy (well under IAM's
 * 10,240-char per-role inline limit) and avoid needing `iam:CreatePolicy` on the
 * bootstrap credentials — only `iam:PutRolePolicy`, which the bootstrap already
 * holds (it creates the role). The blast radius is broad, but a keyless mgmt
 * control-plane identity is inherently near-admin (it provisions IAM, VPCs, EC2,
 * ELB, Route53, KMS for the whole platform). `secretsmanager:*` is included for
 * CAPA parity even though we use insecureSkipSecretsManager.
 */
const CONTROLLER_INLINE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "NebulaMgmtControllers",
      Effect: "Allow",
      Resource: "*",
      Action: [
        "ec2:*",
        "elasticloadbalancing:*",
        "autoscaling:*",
        "iam:*",
        "route53:*",
        "kms:*",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "secretsmanager:*",
        "tag:GetResources",
      ],
    },
  ],
});

export interface AwsIamConfig {
  /** Resource name prefix */
  name: string;
  /**
   * AWS name for the worker node InstanceProfile (referenced by
   * AWSMachineTemplate.iamInstanceProfile).
   * @default 'nodes.cluster-api-provider-aws.sigs.k8s.io'
   */
  instanceProfileName?: string;
  /**
   * AWS-managed policy ARNs to attach to the node role. Self-managed k0s nodes
   * need very little IAM (Calico CNI + Piraeus storage are in-cluster), so the
   * defaults cover ECR image pulls and SSM access only.
   * @default ['AmazonEC2ContainerRegistryReadOnly', 'AmazonSSMManagedInstanceCore']
   */
  managedPolicyArns?: string[];
  /** Extra tags */
  tags?: Record<string, string>;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /**
   * Attach the coarse "mgmt controller" inline policy (see
   * {@link CONTROLLER_INLINE_POLICY}) to the node role so the instance profile
   * carries CAPA + Crossplane permissions. This is what makes the management
   * cluster keyless — its controllers authenticate via the node instance profile
   * (IMDS) instead of a static AWS key. Leave unset for plain worker nodes.
   * @default false
   */
  controllerPolicies?: boolean;
}

/**
 * AwsIam - the IAM role + instance profile for self-managed (CAPA) worker nodes.
 *
 * CAPA requires every AWSMachine to reference an instance profile by name, so
 * this creates one with a deterministic AWS name via the
 * `crossplane.io/external-name` annotation.
 */
export class AwsIam extends Construct {
  /** AWS name of the worker node instance profile */
  public readonly instanceProfileName: string;

  constructor(scope: Construct, id: string, config: AwsIamConfig) {
    super(scope, id);

    const providerConfigRef = { name: config.providerConfigRef ?? "default" };
    const roleName = `${config.name}-node-role`;
    this.instanceProfileName =
      config.instanceProfileName ?? DEFAULT_NODE_INSTANCE_PROFILE;
    const managedPolicyArns = (
      config.managedPolicyArns ?? [
        "AmazonEC2ContainerRegistryReadOnly",
        "AmazonSSMManagedInstanceCore",
      ]
    ).map((p) => (p.startsWith("arn:") ? p : `arn:aws:iam::aws:policy/${p}`));
    const tags = { ...config.tags, "nebula.sh/role": "node" };

    // Node role (deterministic AWS name via external-name annotation)
    new CpRole(this, "node-role", {
      metadata: {
        name: roleName,
        annotations: { "crossplane.io/external-name": roleName },
      },
      spec: {
        forProvider: {
          assumeRolePolicy: EC2_ASSUME_ROLE_POLICY,
          description: "Nebula self-managed worker node role",
          // Keyless mgmt: attach the controller permissions inline on the role
          // (iam:PutRolePolicy only — no iam:CreatePolicy needed) so the instance
          // profile carries CAPA + Crossplane perms.
          ...(config.controllerPolicies
            ? {
                inlinePolicy: [
                  {
                    name: `${config.name}-mgmt-controllers`,
                    policy: CONTROLLER_INLINE_POLICY,
                  },
                ],
              }
            : {}),
          tags,
        },
        providerConfigRef,
      },
    });

    // Attach managed policies
    managedPolicyArns.forEach((arn, i) => {
      new CpRolePolicyAttachment(this, `node-policy-${i}`, {
        metadata: { name: `${config.name}-node-policy-${i}` },
        spec: {
          forProvider: {
            policyArn: arn,
            roleRef: { name: roleName },
          },
          providerConfigRef,
        },
      });
    });

    // Note: nodes do NOT need Secrets Manager access — bootstrap data is
    // delivered via EC2 user-data (cloudInit.insecureSkipSecretsManager on the
    // AWSMachineTemplate), so no customer-managed secretsmanager policy is
    // created here. That also keeps node IAM within PowerUser perms (no
    // iam:CreatePolicy required) and the bootstrap's IAM-ready gate fast.

    // Instance profile (deterministic AWS name so CAPA can reference it)
    new CpInstanceProfile(this, "node-instance-profile", {
      metadata: {
        name: `${config.name}-node-profile`,
        annotations: { "crossplane.io/external-name": this.instanceProfileName },
      },
      spec: {
        forProvider: {
          roleRef: { name: roleName },
          tags,
        },
        providerConfigRef,
      },
    });
  }
}
