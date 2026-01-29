/**
 * Nebula - A library of reusable Pulumi modules for cloud infrastructure.
 * 
 * Usage: Import modules directly and instantiate them in your Pulumi program.
 * Dependencies between modules are handled via Pulumi's native `dependsOn`.
 * Secret resolution (ref+sops://...) is automatic when using any module.
 * 
 * @example
 * ```typescript
 * import { CertManager } from 'nebula/k8s/cert-manager';
 * import { IngressNginx } from 'nebula/k8s/ingress-nginx';
 * 
 * const certManager = new CertManager('cert-manager', {
 *   acmeEmail: 'admin@example.com',
 * });
 * 
 * const ingressNginx = new IngressNginx('ingress-nginx', {
 *   createStaticIp: true,
 * }, { dependsOn: [certManager] });
 * ```
 */

// Core
export { BaseModule } from './core/base-module';
export { setConfig } from './core/config';
export type { NebulaConfig } from './core/config';

// Utilities  
export { Utils, Auth, Helpers } from './utils';
