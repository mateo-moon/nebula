/**
 * Cert-manager full stack test
 * Tests cert-manager component in a realistic setup that mirrors nebula.config.ts:
 * - K8s component wrapper (like in real usage)
 * - Provider created by K8s component using createK8sProvider (reads kubeconfig from path)
 * - Provider passed to CertManager via providers: { kubernetes: this.provider } (as object, not array)
 * - Same provider passing pattern as real nebula.config.ts
 * 
 * This matches the exact pattern from nebula.config.ts:
 *   K8s: (): K8sConfig => ({
 *     kubeconfig: '.config/kube-config-dev-gke',
 *     certManager: {
 *       namespace: 'cert-manager',
 *       acmeEmail: 'devops@kampe.la',
 *     },
 *   })
 */

import { K8s as K8sComponent, component } from "../../src/modules/k8s/index.js";
import { CertManager } from "nebula/k8s/cert-manager";
import { getOrbstackKubeconfig } from "../utils/kubeconfig.js";
import * as k8s from '@pulumi/kubernetes';

console.log("=== Testing Cert-Manager with Full Stack Setup ===\n");
console.log("This test mirrors the real nebula.config.ts structure:\n");
console.log("  - K8s component creates provider internally via createK8sProvider");
console.log("  - K8s component passes provider to CertManager via providers: { kubernetes: this.provider }");
console.log("  - CertManager receives providers as object (not array)");
console.log("  - CertManager should inherit provider and pass it to Helm chart\n");

const { path: kubeconfigPath } = getOrbstackKubeconfig();
console.log(`Using kubeconfig path: ${kubeconfigPath}\n`);

// Simulate the real setup exactly as in nebula.config.ts
// K8s component receives kubeconfig path (not content), creates provider internally,
// and passes it to CertManager via providers: { kubernetes: this.provider }
const k8sComponent = new K8sComponent(
  "test-k8s",
  {
    provider: new k8s.Provider("test-k8s", { kubeconfig: kubeconfigPath }),
    components: [
      component(CertManager, {
        namespace: 'cert-manager',
        acmeEmail: 'dev@example.com',
        // No args.skipAwait in real config - test without it to match reality
      })
    ]
  }
  // No opts passed - K8s component creates provider internally
);

console.log("Created K8s component (which creates CertManager internally)");
console.log(`K8s component URN: ${k8sComponent.urn}`);
console.log(`K8s provider URN: ${k8sComponent.provider?.urn || 'not set'}\n`);

export const k8sComponentUrn = k8sComponent.urn;
export const k8sProviderUrn = k8sComponent.provider?.urn;

