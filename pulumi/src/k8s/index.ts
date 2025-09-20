import { Construct } from "constructs";
import { execSync } from 'child_process';
import { DataHelmTemplate } from "../../.gen/providers/helm/data-helm-template";
import { Manifest } from "../../.gen/providers/kubectl/manifest";
import { DataKubectlFileDocuments } from "../../.gen/providers/kubectl/data-kubectl-file-documents"
import { Namespace } from '../../.gen/providers/kubernetes/namespace';
import { DataKubernetesNamespace } from '../../.gen/providers/kubernetes/data-kubernetes-namespace';
import { TerraformIterator, Fn, Annotations } from 'cdktf';

/**
 * Configuration interface for Kubernetes Helm chart deployment
 * 
 * @interface K8sChartConfig
 */
export interface K8sChartConfig {
  /** Optional name override for the chart release */
  name?: string,
  /** Directory path containing the Helm chart */
  chartDir: string,
  /** Target Kubernetes namespace for deployment */
  namespace?: string,
  /** Additional value files or inline values to merge */
  additionalValues?: string[],
  /** Optional dependencies on other Helm templates */
  dependsOn?: DataHelmTemplate[]
}

/**
 * K8sChart class handles the deployment of Helm charts to Kubernetes
 * 
 * Manages the complete lifecycle of a Helm chart deployment including:
 * - Namespace creation
 * - Custom Resource Definitions (CRDs)
 * - Chart templating and manifest application
 * - Value file processing with environment-specific configurations
 * 
 * @extends {Construct}
 */
export class K8sChart extends Construct {
  /** The processed Helm template data */
  public readonly template: DataHelmTemplate

  /**
   * Creates a new K8sChart instance
   * 
   * @param scope - Parent construct scope
   * @param id - Unique identifier for this chart deployment
   * @param config - Chart configuration options
   */
  constructor(
    public readonly scope: Construct,
    public readonly id: string,
    public readonly config: K8sChartConfig
  ) {
    super(scope, id);

    this.template = this.createTemplate()
    this.apply()
  }

  /**
   * Applies the Helm chart to the Kubernetes cluster
   * 
   * Process:
   * 1. Checks for namespace existence
   * 2. Creates namespace if needed
   * 3. Applies CRDs (Custom Resource Definitions)
   * 4. Applies all chart manifests
   * 
   * Ensures proper deployment order and dependency management
   * 
   * @private
   */
  private apply() {
    const template = this.template
    // Check if namespace already exists
    const namespaceExists = new DataKubernetesNamespace(this, 'data-kubernetes-namespace', {
      metadata: {
        name: template.namespace
      }
    })
    // Create namespace only if it doesn't exist
    const namespace = new Namespace(this, 'namespace', {
      count: Fn.conditional(namespaceExists.count === 0, 1, 0),
      metadata: {
        name: template.namespace
      }
    })
    // Process CRDs from the template
    const crd = TerraformIterator.fromList(template.crds)
    const crdManifests = new Manifest(this, 'crs-manifest', {
      forEach: crd,
      yamlBody: crd.value,
      overrideNamespace: template.namespace,
      applyOnly: true,
      dependsOn: [namespace]
    })
    // Process regular manifests
    const manifests = new DataKubectlFileDocuments(this, 'data-kubectl-file-documents', {
      content: template.manifest
    })
    const manifestIterator = TerraformIterator.fromMap(manifests.manifests)
    // Apply all manifests with proper dependencies
    new Manifest(this, 'manifest', {
      forEach: manifestIterator,
      yamlBody: manifestIterator.value,
      overrideNamespace: template.namespace,
      applyOnly: true,
      dependsOn: [ namespace, crdManifests]
    })
  }

  /**
   * Creates a Helm template from the chart configuration
   * 
   * Processes values files in the following order:
   * 1. Base values.yaml
   * 2. Environment-specific values-{env}.yaml
   * 3. Additional values provided in configuration
   * 
   * Handles variable interpolation and environment-specific configurations
   * 
   * @private
   * @returns {DataHelmTemplate} Processed Helm template
   */
  private createTemplate(): DataHelmTemplate {
    // Process and merge value files with environment-specific overrides
      const values = [
        // Process base values.yaml
        this.executeValuesCommand('values.yaml'),
        // Process environment-specific values
        this.executeValuesCommand(`values-${this.node.getContext('env')}.yaml`),
        // Include any additional value overrides
        ...(this.config.additionalValues || [])
      ];

    // Create and return the Helm template with processed values
    return new DataHelmTemplate(this, this.id, {
      name: this.config.name || this.id,
      chart: this.config.chartDir,
      namespace: this.config.namespace,
      createNamespace: true,
      values,
      ...(this.config.dependsOn && { dependsOn: this.config.dependsOn })
    });
  }

  private executeValuesCommand(filename: string) {
    try {
      return execSync(
        `cd ${this.config.chartDir} && vals eval -s -f ${filename} | sed 's/\\$\{/\\$\\$\{/g'`,
        { stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString();
    } catch (error) {
      Annotations.of(this).addError(`Failed to process values file '${filename}' in directory '${this.config.chartDir}': ${
        error instanceof Error ? error.message : String(error)
      }`)
      return '';
    }
  }
}
