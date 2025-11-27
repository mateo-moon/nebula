/**
 * Cert-manager provider propagation test
 * Ensures cert-manager component works when default providers are disabled.
 */

import * as k8s from "@pulumi/kubernetes";
import { CertManager } from "../../src/components/k8s/cert-manager.js";
import { getOrbstackKubeconfig } from "../utils/kubeconfig.js";

console.log("=== Testing Cert-Manager Component with Explicit Provider ===\n");

const { path: kubeconfigPath, content: kubeconfig } = getOrbstackKubeconfig();

const provider = new k8s.Provider("test-k8s-provider", {
  kubeconfig,
  suppressDeprecationWarnings: true,
});

console.log(`Created explicit Kubernetes provider with kubeconfig: ${kubeconfigPath}`);

const certManager = new CertManager(
  "test-cert-manager",
  {
    acmeEmail: "dev@example.com",
    args: {
      skipAwait: true,
    },
  },
  {
    providers: [provider],
  }
);

export const certManagerUrn = certManager.urn;
export const providerUrn = provider.urn;

