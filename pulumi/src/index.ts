/**
 * Nebula - A framework for building Pulumi infrastructure with modular components.
 * 
 * @example
 * ```typescript
 * import { Component, Utils, defineModule } from 'nebula';
 * 
 * new Component('my-app', {
 *   backendUrl: 'gs://my-state-bucket',
 *   modules: [MyInfraModule()],
 * });
 * ```
 */

export { Component, getCurrentComponent } from './core/component';
export type { ComponentConfig, ModuleFactory } from './core/component';

export { defineModule } from './core/module';
export type { ModuleMetadata, ModuleFactory as TypedModuleFactory } from './core/module';

export { Utils, Auth } from './utils';
export { buildDependencyGraph, detectCycle, topologicalSort, formatDependencyGraph } from './utils/graph';
export type { DependencyGraph } from './utils/graph';

export { runCli as runComponentCli } from './cli';
