import { App } from "cdktf"
import { Project, ProjectConfig } from "@src/core"
import { Infra, InfraConfig } from "@src/components/infra"
import { Secrets, SecretsConfig } from "@src/components/secrets"
import { K8s, K8sConfig } from "@src/components/k8s"
import { config } from "process"
import { IamEksRole } from "@module/terraform-aws-modules/aws/iam/modules/iam-eks-role"
import { TerraformAwsEksExternalDns } from "@module/lablabs/terraform-aws-eks-external-dns"


const root = new App({skipValidation: true})

// Configuration object
const project = new Project(root, "test", {
  id: "test",
  aws: {
    sso_config: {
      sso_region: "us-east-2",
      sso_url: "https://test.awsapps.com/start",
      sso_role_name: "AdministratorAccess"
    }
  },
  environments: {
    dev: {
      backend: { type: "S3" },
      awsConfig: {
        accountId: "703671891971",
        region: "us-east-2",
      },
    },
    prod: {
      backend: { type: "S3" },
      awsConfig: {
        accountId: "471112796903",
        region: "us-east-2",
      }
    },
    test: {
      backend: { type: "S3" },
      awsConfig: {
        accountId: "703671891971",
        region: "us-east-2",
      },
      components: {
        Infra: {
          aws: true
        },
        Secrets: {
          methods: ["kms"]
        },
        // K8s: {
        //   kubeConfig: {
        //     context: "test"
        //   },
        //   charts: ["argo-cd"]
        // },
      }
    },
  },
})

// Role and policy names conflict with current deployment
// Turn off creation of those resources
const externalDnsTest = project.node.findChild('test').node.findChild('infra-test').node.findChild('eks').node.findChild('external-dns').node.children[0] as TerraformAwsEksExternalDns
externalDnsTest.addOverride('irsa_role_create', false)
externalDnsTest.addOverride('irsa_policy_enabled', false)
// TODO(OP): test if this will work after ArgoCD is deployed
externalDnsTest.addOverride('argo_enabled', false)
externalDnsTest.addOverride('argo_namespace', "argo-cd")

// const secretsTest = project.node.findChild('secrets-test') as Secrets
// secretsTest.inputs = {
//   arns: [
//     (project.node.findChild('argo-cd-role') as IamEksRole).iamRoleArnOutput
//   ]
// }

// Synthesize the project
root.synth();
