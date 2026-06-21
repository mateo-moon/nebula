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
