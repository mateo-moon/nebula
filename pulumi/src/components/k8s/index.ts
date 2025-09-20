import * as yaml from 'yaml';
import { deepmerge } from "deepmerge-ts";
import { IResolver, ResolutionContext } from 'cdk8s';
import { execSync } from 'child_process';
import { Construct } from 'constructs';
import {
  Chart as Cdk8sChart,
  ChartProps as Cdk8sChartProps,
  App as Cdk8sApp,
  ApiObject,
  JsonPatch
} from 'cdk8s';
import { Aspects, Fn } from 'cdktf';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';
import { KubernetesProviderConfig } from '../../../.gen/providers/kubernetes/provider';
import { Manifest } from '../../../.gen/providers/kubernetes/manifest';
import { Namespace } from '../../../.gen/providers/kubernetes/namespace';
import { DataKubernetesNamespace } from '../../../.gen/providers/kubernetes/data-kubernetes-namespace';
import { RenameDependencies, WithAwsProvider, WithK8sProvider } from '../../utils/decorators';
import { UpdateComputedFields } from '../../utils/aspects';
import { CdktfResolver } from '@cdk8s/cdktf-resolver';
import { Application } from '../../../imports/argo-cd-crd-argoproj.io'

export interface K8sConfig  {
  kubeConfig?: KubernetesProviderConfig
  charts?: Chart[]
}

export class K8s extends Construct implements K8sConfig
{
  public get kubeConfig() {return this.config?.kubeConfig}
  constructor(
    public readonly env: Environment,
    public readonly id: string,
    public readonly config?: K8sConfig
  ) {
    super(env, id);
  }

  public init(): K8s {
    return this
  }
}

function wrapLeafStringKeys(object: any): any {
  if (typeof object === "string") {
    return object
      // .replace(/\n/g, "\\n") // escape newlines
      .replace(/\${/g, "$$${"); // escape ${ to $${;
  }
  const ret = Object.entries(object).reduce((acc, [key, value]) => {
    if (typeof value === "string") {
      return {
        ...acc,
        [key]: wrapLeafStringKeys(value),
      };
    }
    if (typeof value === "object") {
      if (Array.isArray(value)) {
        return {
          ...acc,
          [key]: value.map(wrapLeafStringKeys),
        };
      } else {
        return {
          ...acc,
          [key]: wrapLeafStringKeys(value),
        };
      }
    }
    return { ...acc, [key]: value };
  }, {} as Record<string, any>);
  return ret;
}

export interface AppConfig {
  argo?: {
    project?: string
    repoUrl?: string
    targetRevision?: string
    path?: string
  }
}

@RenameDependencies()
@WithAwsProvider()
@WithK8sProvider()
export class App extends Component {
  public cdk8sApp: Cdk8sApp
  public get chart() {return this.cdk8sApp.charts[0]}
  constructor(
    public readonly env: Environment,
    public readonly id: string,
    public readonly config?: AppConfig
  ) {
    super(env, id);
    Aspects.of(this).add(new UpdateComputedFields());
    this.cdk8sApp = new Cdk8sApp({resolvers: [
      new CdktfResolver({app: env.project}),
      new ValsResolver()
    ]});
  }

  public init(): App {
    return this
  }


  public createArgoCDApp(): void {
    if (!this.chart) {
      throw new Error('Chart is not defined');
    }
    const config = this.config?.argo
    // Get the relative path from git repo root to __dirname
    const gitRepoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
    const relativePath = __dirname.replace(gitRepoRoot + '/', '');
    const gitOriginUrl = execSync('git config --get remote.origin.url').toString().trim();

    new Application(this.chart, this.id, {
      metadata: {
        name: this.id,
        namespace: 'argo-cd'
      },
      spec: {
        project: config?.project ?? "default",
        source: {
          repoUrl: config?.repoUrl ?? gitOriginUrl,
          targetRevision: config?.targetRevision ?? 'HEAD',
          path: config?.path ?? relativePath,
          plugin: {
            parameters: [{
              name: "env",
              string: this.env.id
            }]
          }
        },
        destination: {
          namespace: this.chart?.namespace ?? this.id,
          server: "https://kubernetes.default.svc"
        },
        syncPolicy: {
          // automated: {
          //   prune: true,
          //   selfHeal: true
          // },
          syncOptions: [
            "CreateNamespace=true",
            "ApplyOutOfSyncOnly=true",
            "PruneLast=true",
            "FailOnSharedResource=true"
          ],
          retry: {limit: 3}
        }
      }
    })
  }

  public apply(): void {
    const namespaceResource = this.createNamespace()
    const yamlManifests = yaml.parseAllDocuments(
      this.cdk8sApp.synthYaml()
    );

    yamlManifests.forEach((yamlManifest) => {
      const jsonManifest = yamlManifest.toJSON();
      const type = `${jsonManifest.apiVersion}-${jsonManifest.kind}`;
      const namespace = jsonManifest.metadata.namespace || this.chart?.namespace;
      const uniqueId = `${
        jsonManifest.metadata.name || jsonManifest.metadata.generateName
      }-${namespace}`;
      const manifestContent = wrapLeafStringKeys(jsonManifest);

      new Manifest(this, `${this.id}-${type}-${uniqueId}`, {
        manifest: manifestContent,
        dependsOn: [namespaceResource],
        fieldManager: {
          forceConflicts: true
        }
      });
    });
  }

  private createNamespace(): Namespace {
    const namespaceExists = new DataKubernetesNamespace(this, 'data-kubernetes-namespace', {
      metadata: {
        name: this.chart?.namespace
      }
    })
    // Create namespace only if it doesn't exist
    const namespace = new Namespace(this, 'namespace', {
      count: Fn.conditional((namespaceExists.count == 0 || namespaceExists.count == undefined), 1, 0),
      metadata: {
        name: this.chart?.namespace
      }
    })
    return namespace
  }

  public deployResources(chart: Chart): void {
    if ((chart as any).deployResources === 'function') {
      (chart as any).deployResources(this)
    }
  }

  public synth(): void {
    this.cdk8sApp.synth()
  }
}

export interface ChartProps extends Cdk8sChartProps {
}

export class Chart extends Cdk8sChart {

  constructor(
    public readonly scope: App,
    public readonly id: string,
    public readonly props?: ChartProps
  ) {
    super(scope.cdk8sApp, id, {
      namespace: props?.namespace ?? id,
      labels: props?.labels,
      disableResourceNameHashes: true
    });
  }

  get apiObjects(): ApiObject[] {
    const apiObjects: ApiObject[] = []
    this.node.findAll().forEach((node) => {
      if (node instanceof ApiObject) {
        apiObjects.push(node)
      }
    })
    return apiObjects
  }

  public removeNamespaceFromClusterScopedResources() {
    this.apiObjects.forEach((apiObject) => {
      if (
        apiObject.kind === 'ValidatingWebhookConfiguration' ||
        apiObject.kind === 'MutatingWebhookConfiguration' ||
        apiObject.kind === 'ClusterRoleBinding' ||
        apiObject.kind === 'ClusterRole' ||
        apiObject.kind === 'CustomResourceDefinition' ||
        apiObject.kind === 'PriorityClass' ||
        apiObject.kind === 'StorageClass' ||
        apiObject.kind === 'IngressClass' ||
        apiObject.kind === 'ClusterIssuer'
      ) {
        apiObject.addJsonPatch(JsonPatch.remove('/metadata/namespace'))
      }
    })
  }
}

export class ValsResolver implements IResolver {
  constructor() {
  }

  public resolve(context: ResolutionContext) {
    if (context.replaced) return;
    if (typeof context.value === 'string' && context.value.startsWith('ref+')) {
      const absolutePath = context.value.replace('ref+sops://', `ref+sops://${projectRoot}/`);
      const decodedValue = execSync(`vals get ${absolutePath}`).toString().trim();
      context.replaceValue(decodedValue);
    }
    if (typeof context === 'object' && context.value.kind === "Secret" && context.value.data) {
      Object.entries(context.value.data).forEach(([key, value]) => {
        const decodedValue = Buffer.from(value as any, 'base64').toString('utf-8');
        if (decodedValue.startsWith('ref+')) {
          const absolutePath = decodedValue.replace('ref+sops://', `ref+sops://${projectRoot}/`);
          const secret = execSync(`vals get ${absolutePath}`).toString().trim();
          context.replaceValue(deepmerge(context.value, {data: {[key]: Buffer.from(secret, 'binary').toString('base64')}}))
        }
      })
    }
  }
}
