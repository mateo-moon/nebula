/**
 * Example: All XRDs
 * 
 * Generates all XRDs and Compositions for the Nebula platform.
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/all-xrds.ts"
 * 
 * Output:
 *   dist/*.k8s.yaml - Apply these to your Crossplane cluster
 */
import { App } from 'cdk8s';
import { 
  GcpInfrastructureXrd,
  CertManagerXrd,
  ExternalDnsXrd,
  IngressNginxXrd,
} from '../src';

const app = new App();

// Infrastructure XRD
new GcpInfrastructureXrd(app, 'gcp-infrastructure-xrd');

// Platform module XRDs
new CertManagerXrd(app, 'cert-manager-xrd');
new ExternalDnsXrd(app, 'external-dns-xrd');
new IngressNginxXrd(app, 'ingress-nginx-xrd');

app.synth();
