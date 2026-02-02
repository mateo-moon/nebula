// Crossplane core CRDs
export * from './xrd';
export * from './composition';

// Crossplane GCP Provider CRDs
export * from './cluster';
export * from './nodepool';
export * from './network';
export * from './subnetwork';
export * from './firewall';
export * from './serviceaccount';
export * from './serviceaccountiammember';
export * from './projectiammember';

// Crossplane Helm Provider CRDs
export * from './helm-release';

// Crossplane GCP DNS Provider CRDs
export * from './managedzone';

// Crossplane Cloudflare Provider CRDs
export * from './cloudflare-record';

// Nebula Claims (auto-generated from XRDs)
export * from './certmanager-claim';
export * from './dns-claim';
export * from './externaldns-claim';
export * from './gcpinfrastructure-claim';
export * from './ingressnginx-claim';
