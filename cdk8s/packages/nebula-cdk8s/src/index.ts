// Infrastructure module (direct resource generation)
export * from './infrastructure/index.js';

// XRDs and Compositions (Crossplane abstractions)
export * from './xrd/gcp-infrastructure.js';

// Re-export Crossplane CRD types for direct use
export * from '../imports/index.js';
