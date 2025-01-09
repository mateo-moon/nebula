import { Construct } from "constructs";
import { execSync } from 'child_process';
import { DataHelmTemplate } from "@provider/helm/data-helm-template";
import { Manifest } from "@provider/kubectl/manifest";
import { DataKubectlFileDocuments } from "@provider/kubectl/data-kubectl-file-documents"
import { Namespace } from '@provider/kubernetes/namespace';
import { DataKubernetesNamespace } from '@provider/kubernetes/data-kubernetes-namespace';
import { TerraformIterator, Fn, Annotations } from 'cdktf';

export interface K8sChartConfig {
  name?: string,
  chartDir: string,
  namespace?: string,
  additionalValues?: string[],
  dependsOn?: DataHelmTemplate[]
}

export class K8sChart extends Construct {
  public readonly template: DataHelmTemplate

  constructor(
    public readonly scope: Construct,
    public readonly id: string,
    public readonly config: K8sChartConfig
  ) {
    super(scope, id);

    this.template = this.createTemplate()
    this.apply()
  }

  private apply() {
    const template = this.template
    const namespaceExists = new DataKubernetesNamespace(this, 'data-kubernetes-namespace', {
      metadata: {
        name: template.namespace
      }
    })
    const namespace = new Namespace(this, 'namespace', {
      count: Fn.conditional(namespaceExists.count === 0, 1, 0),
      metadata: {
        name: template.namespace
      }
    })
    const crd = TerraformIterator.fromList(template.crds)
    const crdManifests = new Manifest(this, 'crs-manifest', {
      forEach: crd,
      yamlBody: crd.value,
      overrideNamespace: template.namespace,
      applyOnly: true,
      dependsOn: [namespace]
    })
    const manifests = new DataKubectlFileDocuments(this, 'data-kubectl-file-documents', {
      content: template.manifest
    })
    const manifestIterator = TerraformIterator.fromMap(manifests.manifests)
    new Manifest(this, 'manifest', {
      forEach: manifestIterator,
      yamlBody: manifestIterator.value,
      overrideNamespace: template.namespace,
      applyOnly: true,
      dependsOn: [ namespace, crdManifests]
    })
  }

  private createTemplate(): DataHelmTemplate {
    const values = [
      execSync(`cd ${this.config.chartDir} && vals eval -s -f values.yaml | sed 's/\\$\{/\\$\\$\{/g'`).toString(),
      execSync(`cd ${this.config.chartDir} && vals eval -s -f values-${this.node.getContext('env')}.yaml | sed 's/\\$\{/\\$\\$\{/g'`).toString(),
      ...(this.config.additionalValues || [])
    ];

    return new DataHelmTemplate(this, this.id, {
      name: this.config.name || this.id,
      chart: this.config.chartDir,
      namespace: this.config.namespace,
      createNamespace: true,
      values,
      ...(this.config.dependsOn && { dependsOn: this.config.dependsOn })
    });
  }
}
