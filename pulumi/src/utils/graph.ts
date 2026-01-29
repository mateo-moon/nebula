/**
 * Dependency graph utilities for module ordering.
 * 
 * Provides functions to build, analyze, and sort a dependency graph
 * based on module metadata (provides/requires capabilities).
 */
import type { ModuleFactory } from '../core/module';

/**
 * Represents a dependency graph built from module factories.
 */
export interface DependencyGraph {
  /** Map of module name -> module names it depends on */
  edges: Map<string, string[]>;
  /** Map of capability -> module name that provides it */
  capabilityProviders: Map<string, string>;
  /** Map of module name -> factory */
  modulesByName: Map<string, ModuleFactory>;
}

/**
 * Build a dependency graph from module factories.
 * 
 * Analyzes module metadata to determine:
 * - Which modules provide which capabilities
 * - Which modules depend on which other modules (via capabilities)
 * 
 * @param modules - Array of module factories to analyze
 * @returns A dependency graph structure
 */
export function buildDependencyGraph(modules: ModuleFactory[]): DependencyGraph {
  const edges = new Map<string, string[]>();
  const capabilityProviders = new Map<string, string>();
  const modulesByName = new Map<string, ModuleFactory>();

  // First pass: collect all capabilities and map to providers
  for (const mod of modules) {
    const meta = mod.__moduleMetadata;
    if (meta) {
      modulesByName.set(meta.name, mod);
      for (const cap of meta.provides || []) {
        if (capabilityProviders.has(cap)) {
          console.warn(
            `[Nebula] Capability '${cap}' provided by multiple modules: ` +
            `'${capabilityProviders.get(cap)}' and '${meta.name}'. Using first provider.`
          );
        } else {
          capabilityProviders.set(cap, meta.name);
        }
      }
    }
  }

  // Second pass: build dependency edges
  for (const mod of modules) {
    const meta = mod.__moduleMetadata;
    if (meta) {
      const deps: string[] = [];
      for (const req of meta.requires || []) {
        const provider = capabilityProviders.get(req);
        if (provider) {
          // Avoid self-dependency
          if (provider !== meta.name) {
            deps.push(provider);
          }
        } else {
          console.warn(
            `[Nebula] Module '${meta.name}' requires '${req}' ` +
            `but no module provides it. This may cause runtime errors.`
          );
        }
      }
      edges.set(meta.name, deps);
    }
  }

  return { edges, capabilityProviders, modulesByName };
}

/**
 * Detect cycles in the dependency graph.
 * 
 * Uses depth-first search to find back edges indicating cycles.
 * 
 * @param graph - The dependency graph to check
 * @returns Array representing the cycle path (e.g., ['a', 'b', 'c', 'a']), or null if no cycle
 */
export function detectCycle(graph: DependencyGraph): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (visiting.has(node)) {
      // Found cycle - return path from cycle start to current node
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visiting.add(node);
    path.push(node);

    for (const dep of graph.edges.get(node) || []) {
      const cycle = dfs(dep, path);
      if (cycle) return cycle;
    }

    visiting.delete(node);
    visited.add(node);
    path.pop();
    return null;
  }

  for (const node of graph.edges.keys()) {
    const cycle = dfs(node, []);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Topologically sort modules based on their dependencies.
 * 
 * Ensures that if module A depends on module B, B appears before A in the result.
 * Modules without metadata are appended at the end in their original order.
 * 
 * @param modules - Array of module factories to sort
 * @param graph - The dependency graph built from these modules
 * @returns Sorted array of module factories
 */
export function topologicalSort(
  modules: ModuleFactory[],
  graph: DependencyGraph
): ModuleFactory[] {
  const visited = new Set<string>();
  const result: ModuleFactory[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);

    // Visit dependencies first (they must come before this module)
    for (const dep of graph.edges.get(name) || []) {
      visit(dep);
    }

    // Add this module after its dependencies
    const mod = graph.modulesByName.get(name);
    if (mod) result.push(mod);
  }

  // Visit all modules with metadata
  for (const mod of modules) {
    const name = mod.__moduleMetadata?.name;
    if (name) {
      visit(name);
    }
  }

  // Append modules without metadata at the end (preserve original order)
  for (const mod of modules) {
    if (!mod.__moduleMetadata?.name) {
      result.push(mod);
    }
  }

  return result;
}

/**
 * Get a human-readable representation of the dependency graph.
 * Useful for debugging and logging.
 * 
 * @param graph - The dependency graph to format
 * @returns Formatted string representation
 */
export function formatDependencyGraph(graph: DependencyGraph): string {
  const lines: string[] = ['Dependency Graph:'];
  
  for (const [name, deps] of graph.edges.entries()) {
    if (deps.length > 0) {
      lines.push(`  ${name} -> ${deps.join(', ')}`);
    } else {
      lines.push(`  ${name} (no dependencies)`);
    }
  }
  
  if (graph.capabilityProviders.size > 0) {
    lines.push('');
    lines.push('Capabilities:');
    for (const [cap, provider] of graph.capabilityProviders.entries()) {
      lines.push(`  ${cap} <- ${provider}`);
    }
  }
  
  return lines.join('\n');
}
