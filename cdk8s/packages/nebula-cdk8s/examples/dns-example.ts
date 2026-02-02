/**
 * Example: DNS Zone with Cloudflare Delegation
 * 
 * This generates:
 * 1. The XRD + Composition - installed once in the cluster
 * 2. A Dns claim - creates GCP DNS zone and Cloudflare NS delegation
 * 
 * Usage:
 *   npx cdk8s synth --app "npx tsx examples/dns-example.ts"
 * 
 * Output:
 *   dist/dns-xrd.k8s.yaml     - Install this first (XRD + Composition)
 *   dist/dns-claim.k8s.yaml   - Then apply this claim
 */
import { App, Chart } from 'cdk8s';
import { Construct } from 'constructs';
import { DnsXrd, Dns, DnsSpecDelegationsProvider } from '../src';

const app = new App();

// ==================== XRD + COMPOSITION ====================
new DnsXrd(app, 'dns-xrd');

// ==================== CLAIM ====================
class DnsClaim extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Basic DNS zone without delegation
    new Dns(this, 'basic', {
      metadata: {
        name: 'example-dns',
        namespace: 'default',
      },
      spec: {
        project: 'geometric-watch-472309-h6',
        domain: 'example.com',
        description: 'Example DNS zone managed by Crossplane',
      },
    });

    // DNS zone with Cloudflare delegation
    new Dns(this, 'with-delegation', {
      metadata: {
        name: 'delegated-dns',
        namespace: 'default',
      },
      spec: {
        project: 'geometric-watch-472309-h6',
        domain: 'sub.example.com',
        description: 'Subdomain with Cloudflare delegation',
        delegations: [
          {
            provider: DnsSpecDelegationsProvider.CLOUDFLARE,
            zoneId: 'your-cloudflare-zone-id',
            ttl: 3600,
            // providerConfigRef: 'cloudflare-production', // optional, defaults to 'default'
          },
        ],
      },
    });
  }
}

new DnsClaim(app, 'dns-claim');

app.synth();
