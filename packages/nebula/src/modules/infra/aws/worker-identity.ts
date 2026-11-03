import { Construct } from "constructs";
import { Role, RolePolicyAttachment, Policy, InstanceProfile } from "#imports/iam.aws.upbound.io";

/** Existing worker role/profile and its retained address/disk permissions. */
export class AwsWorkerIdentity extends Construct {
  readonly instanceProfileName: string;
  constructor(scope: Construct, id: string, config: { namePrefix: string; providerConfigName?: string }) {
    super(scope, id);
    const pcRef = { name: config.providerConfigName ?? "default" };
    const roleName = `${config.namePrefix}-worker-node`;
    new Role(this, "worker-node-role", {
      metadata: { name: roleName },
      spec: {
        forProvider: {
          assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
        },
        providerConfigRef: pcRef,
      },
    });
    // Boot self-assembly: the node claims its EIP and data volume with its
    // own role over IMDS. Associate/attach cannot be resource-scoped without
    // per-call tag conditions the boot script cannot guarantee, so the action
    // list is the whole grant.
    const selfAssemblyPolicyName = `${roleName}-self-assembly`;
    new Policy(this, "worker-node-self-assembly-policy", {
      metadata: { name: selfAssemblyPolicyName },
      spec: {
        forProvider: {
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "NodeSelfAssembly",
                Effect: "Allow",
                Resource: "*",
                Action: [
                  "ec2:AssociateAddress",
                  "ec2:DescribeAddresses",
                  "ec2:AttachVolume",
                  "ec2:DescribeVolumes",
                  "ec2:DescribeInstances",
                  "ec2:ModifyInstanceAttribute",
                ],
              },
            ],
          }),
        },
        providerConfigRef: pcRef,
      },
    });
    new RolePolicyAttachment(this, "worker-node-self-assembly", {
      metadata: { name: `${roleName}-self-assembly` },
      spec: {
        forProvider: {
          policyArnRef: { name: selfAssemblyPolicyName },
          roleRef: { name: roleName },
        },
        providerConfigRef: pcRef,
      },
    });
    new InstanceProfile(this, "worker-node-profile", {
      metadata: { name: roleName },
      spec: {
        forProvider: { roleRef: { name: roleName } },
        providerConfigRef: pcRef,
      },
    });
    this.instanceProfileName = roleName;
  }
}
