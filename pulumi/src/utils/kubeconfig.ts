import * as fs from 'fs';
import * as path from 'path';
import * as pulumi from '@pulumi/pulumi';
import * as YAML from 'yaml';

/**
 * Options for writing a kubeconfig file
 */
export interface KubeconfigWriteOptions {
  /** The kubeconfig content as a string */
  kubeconfig: pulumi.Input<string>;
  /** Project name (e.g., 'kurtosis', 'myapp') - extracted from Pulumi project if not provided */
  projectName?: string;
  /** Environment prefix (e.g., 'dev', 'prod') - extracted from stack name if not provided */
  envPrefix?: string;
  /** Provider type (e.g., 'gke', 'eks', 'constellation') */
  provider: string;
  /** Optional cluster name or identifier for more specific naming */
  clusterName?: string;
  /** Optional cluster ID for unique identification */
  clusterId?: string;
}

/**
 * Result of writing a kubeconfig file
 */
export interface KubeconfigWriteResult {
  /** The full path where the kubeconfig was written */
  filePath: string;
  /** The filename that was used */
  fileName: string;
}

/**
 * Validates kubeconfig content format
 * @param kubeconfig - The kubeconfig content to validate
 * @returns true if valid, false otherwise
 */
export function validateKubeconfig(kubeconfig: string): boolean {
  if (!kubeconfig || typeof kubeconfig !== 'string') {
    return false;
  }
  
  // Check for basic kubeconfig structure
  if (!kubeconfig.includes('apiVersion: v1') || !kubeconfig.includes('kind: Config')) {
    return false;
  }
  
  return true;
}

/**
 * Cleans up redundant parts in a cluster/context name
 * Removes duplicate project names and provider suffixes
 * Examples:
 *  - "kurtosis-kurtosis-dev-gke" -> "kurtosis-dev-gke" 
 *  - "myapp-myapp-prod-eks" -> "myapp-prod-eks"
 * @param name - The name to clean
 * @returns The cleaned name
 */
export function cleanClusterName(name: string): string {
  if (!name) return name;
  
  const parts = name.split('-');
  if (parts.length < 3) return name;
  
  // Check if first two parts are the same (duplicate project name)
  if (parts[0] === parts[1]) {
    return parts.slice(1).join('-');
  }
  
  // Check if the pattern is project-project-env-provider
  // and remove the duplicate
  if (parts.length >= 4) {
    const [first, second] = parts;
    // If first part appears again in the name, remove the duplicate
    const withoutFirst = parts.slice(1).join('-');
    if (first && withoutFirst.includes(first) && first === second) {
      return withoutFirst;
    }
  }
  
  return name;
}

/**
 * Extracts the current context name from kubeconfig content
 * @param kubeconfig - The kubeconfig content as a string
 * @returns The context name, or undefined if not found
 */
export function extractContextName(kubeconfig: string): string | undefined {
  try {
    const parsed = YAML.parse(kubeconfig);
    if (parsed && typeof parsed === 'object') {
      // Try to get current-context first
      if (parsed['current-context']) {
        return parsed['current-context'];
      }
      // Fallback: get the first context name
      if (parsed.contexts && Array.isArray(parsed.contexts) && parsed.contexts.length > 0) {
        return parsed.contexts[0].name;
      }
      // Fallback: get the first cluster name
      if (parsed.clusters && Array.isArray(parsed.clusters) && parsed.clusters.length > 0) {
        return parsed.clusters[0].name;
      }
    }
  } catch (error) {
    // If parsing fails, try regex fallback
    const contextMatch = kubeconfig.match(/current-context:\s*(.+)/);
    if (contextMatch && contextMatch[1]) {
      return contextMatch[1].trim();
    }
  }
  return undefined;
}

/**
 * Extracts unique part from cluster name that isn't already in env-provider
 * Examples:
 *  - clusterName: "kurtosis-dev-gke", env: "dev", provider: "gke" → "kurtosis"
 *  - clusterName: "myapp-prod-eks", env: "prod", provider: "eks" → "myapp"
 *  - clusterName: "custom-cluster", env: "dev", provider: "gke" → "custom-cluster"
 * @param clusterName - The full cluster name
 * @param envPrefix - The environment prefix
 * @param provider - The provider name
 * @returns The unique part or undefined if redundant
 */
function extractUniqueClusterPart(clusterName: string, envPrefix: string, provider: string): string | undefined {
  if (!clusterName) return undefined;
  
  // Check if cluster name ends with env-provider pattern
  const envProviderSuffix = `${envPrefix}-${provider}`;
  if (clusterName.endsWith(envProviderSuffix)) {
    // Extract the prefix part
    const prefix = clusterName.substring(0, clusterName.length - envProviderSuffix.length);
    if (prefix.endsWith('-')) {
      return prefix.slice(0, -1); // Remove trailing dash
    }
    // If no prefix left after removing env-provider, don't add anything
    return prefix || undefined;
  }
  
  // Check if cluster name contains env and provider separately
  const parts = clusterName.split('-');
  const hasEnv = parts.includes(envPrefix);
  const hasProvider = parts.includes(provider);
  
  // If both env and provider are in the name, likely redundant
  if (hasEnv && hasProvider) {
    // Try to extract the unique prefix
    const envIndex = parts.indexOf(envPrefix);
    if (envIndex > 0) {
      // Return parts before env
      return parts.slice(0, envIndex).join('-');
    }
    return undefined; // Fully redundant
  }
  
  // Return full cluster name if it doesn't contain env-provider pattern
  return clusterName;
}

/**
 * Generates a standardized kubeconfig filename
 * Format: kube-config-{projectName}-{envPrefix}-{provider}[-{clusterId}]
 * 
 * @param options - Options for filename generation
 * @returns The generated filename
 */
export function generateKubeconfigFileName(options: {
  projectName?: string;
  envPrefix: string;
  provider: string;
  clusterName?: string;
  clusterId?: string;
}): string {
  const parts = ['kube-config'];
  
  // Add project name if provided
  if (options.projectName) {
    parts.push(options.projectName);
  }
  
  parts.push(options.envPrefix, options.provider);
  
  // Skip cluster name to avoid duplication since project-env-provider is usually enough
  // Only add it if it's truly unique and different from project name
  if (options.clusterName && options.clusterName !== options.projectName) {
    const uniquePart = extractUniqueClusterPart(options.clusterName, options.envPrefix, options.provider);
    // Only add if the unique part is different from project name
    if (uniquePart && uniquePart !== options.projectName) {
      parts.push(uniquePart);
    }
  }
  
  if (options.clusterId !== undefined && options.clusterId !== null) {
    parts.push(options.clusterId);
  }
  
  return parts.join('-');
}

/**
 * Gets the config directory path (.config)
 * @returns The absolute path to the config directory
 */
export function getConfigDirectory(): string {
  return path.resolve((global as any).projectRoot || process.cwd(), '.config');
}

/**
 * Ensures the config directory exists
 * @returns The absolute path to the config directory
 */
export function ensureConfigDirectory(): string {
  const configDir = getConfigDirectory();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * Extracts environment prefix from Pulumi stack name
 * @param stackName - The Pulumi stack name (e.g., 'dev-gke-cluster')
 * @returns The environment prefix (e.g., 'dev')
 */
export function extractEnvPrefix(stackName?: string): string {
  if (!stackName) {
    try {
      stackName = pulumi.getStack();
    } catch {
      return 'default';
    }
  }
  return String(stackName).split('-')[0] || 'default';
}

/**
 * Writes a kubeconfig file to the .config directory
 * This function handles validation, directory creation, and file writing.
 * 
 * The filename format will be: kube-config-{project}-{env}-{provider}
 * For example: kube-config-kurtosis-dev-gke
 * 
 * Project name is automatically extracted from pulumi.getProject() if not provided.
 * 
 * @param options - Options for writing the kubeconfig
 * @returns A Pulumi Output that resolves when the file is written, containing the file path
 */
export function writeKubeconfig(options: KubeconfigWriteOptions): pulumi.Output<KubeconfigWriteResult> {
  return pulumi.output(options.kubeconfig).apply((cfgStr) => {
    try {
      // Validate kubeconfig format before writing
      if (!validateKubeconfig(cfgStr)) {
        console.warn('Invalid kubeconfig: empty, not a string, or missing required fields');
        throw new Error('Invalid kubeconfig format');
      }
      
      // Ensure config directory exists
      const configDir = ensureConfigDirectory();
      
      // Extract project name if not provided
      const projectName = options.projectName || pulumi.getProject();
      
      // Extract environment prefix if not provided
      const envPrefix = options.envPrefix || extractEnvPrefix();
      
      // Use explicitly provided cluster name only
      // Don't auto-extract from context to keep filenames clean
      let clusterName = options.clusterName;
      
      // Generate filename (only include optional fields if they're defined)
      const fileNameOptions: {
        projectName?: string;
        envPrefix: string;
        provider: string;
        clusterName?: string;
        clusterId?: string;
      } = {
        projectName,
        envPrefix,
        provider: options.provider,
      };
      
      if (clusterName) {
        fileNameOptions.clusterName = clusterName;
      }
      
      if (options.clusterId) {
        fileNameOptions.clusterId = options.clusterId;
      }
      
      const fileName = generateKubeconfigFileName(fileNameOptions);
      
      const filePath = path.resolve(configDir, fileName);
      
      // Write file
      fs.writeFileSync(filePath, cfgStr);
      
      console.log(`Kubeconfig written to: ${filePath}`);
      
      return {
        filePath,
        fileName,
      };
    } catch (error) {
      console.warn('Failed to write kubeconfig:', error);
      throw error;
    }
  });
}

/**
 * Finds kubeconfig files in the .config directory
 * @param envPrefix - Optional environment prefix to filter by
 * @returns Array of kubeconfig filenames
 */
export function findKubeconfigFiles(envPrefix?: string): string[] {
  const configDir = getConfigDirectory();
  
  if (!fs.existsSync(configDir)) {
    return [];
  }
  
  const files = fs.readdirSync(configDir);
  let kubeconfigFiles = files.filter(f => 
    f.startsWith('kube-config-') || f.startsWith('kube_config')
  );
  
  // Filter by environment prefix if provided
  if (envPrefix) {
    const envLower = envPrefix.toLowerCase();
    kubeconfigFiles = kubeconfigFiles.filter(f => {
      const fLower = f.toLowerCase();
      // Match patterns: kube-config-{env}- or kube_config_{env}_
      if (fLower.startsWith('kube-config-')) {
        const afterPrefix = fLower.substring('kube-config-'.length);
        return afterPrefix.startsWith(`${envLower}-`);
      }
      if (fLower.startsWith('kube_config_')) {
        const afterPrefix = fLower.substring('kube_config_'.length);
        return afterPrefix.startsWith(`${envLower}_`);
      }
      return false;
    });
  }
  
  return kubeconfigFiles.sort();
}

/**
 * Gets the full path to a kubeconfig file
 * @param fileName - The kubeconfig filename
 * @returns The full path to the file
 */
export function getKubeconfigPath(fileName: string): string {
  const configDir = getConfigDirectory();
  return path.resolve(configDir, fileName);
}

