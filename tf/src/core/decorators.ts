import { Construct } from "constructs";
import { AwsProvider, AwsProviderConfig} from "@provider/aws/provider";
import { LocalProvider, LocalProviderConfig } from "@provider/local/provider";
import { KubernetesProvider, KubernetesProviderConfig } from "@provider/kubernetes/provider";
import { HelmProvider } from "@provider/helm/provider";
import { KubectlProvider, KubectlProviderConfig } from "@provider/kubectl/provider";

export function WithAwsProvider(awsConfig?: AwsProviderConfig) {
  return function _WithAwsProvider<T extends {new(...args: any[]): Construct}>(constr: T){
    const decoratedClass = class extends constr {
      constructor(...args: any[]) {
        const [env, id, config] = args
        super(env, id, config)

        new AwsProvider(this, 'aws', awsConfig ?? env.config?.awsConfig)
      }
    }
    Object.defineProperty(decoratedClass, 'name', { value: constr.name });
    return decoratedClass;
  }
}

export function WithLocalProvider(localConfig?: LocalProviderConfig) {
  return function _WithLocalProvider<T extends {new(...args: any[]): Construct}>(constr: T){
    const decoratedClass = class extends constr {
      constructor(...args: any[]) {
        const [env, id] = args
        super(env, id)

        new LocalProvider(env, 'local', localConfig ?? {})
      }
    }
    Object.defineProperty(decoratedClass, 'name', { value: constr.name });
    return decoratedClass;
  }
}

export function WithK8sProvider(k8sConfig?: KubernetesProviderConfig) {
  return function _WithK8sProvider<T extends {new(...args: any[]): Construct}>(constr: T){
    const decoratedClass = class extends constr {
      constructor(...args: any[]) {
        const [scope, id, config] = args
        super(scope, id, config)

        const actualK8sConfig = k8sConfig ?? {
          configPath: `${projectConfigPath}/kube_config`,
          configContext: config.kubeConfig.context
        }

        new KubernetesProvider(this, "k8s-provider", actualK8sConfig)
        new HelmProvider(this, "helm-provider", {
          kubernetes: {
            configPath: actualK8sConfig.configPath,
            configContext: actualK8sConfig.configContext,
          }
        })
        new KubectlProvider(this, "kubectl-provider", actualK8sConfig as KubectlProviderConfig)
      }
    }
    Object.defineProperty(decoratedClass, 'name', { value: constr.name });
    return decoratedClass;
  }
}
