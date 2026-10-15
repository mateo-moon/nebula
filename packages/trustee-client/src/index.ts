export { prepareClient, type PrepareClientOptions } from "./prepare.js";
export { TrusteeClient, type TrusteeClientOptions, TrusteeHttpError } from "./client.js";
export { buildTngClient } from "./build-tng.js";
export { createOwnerToken } from "./owner-token.js";
// Compile the same pure policy and configuration sources into this package.
// Installed clients need neither cdk8s nor a checkout nor a TypeScript loader.
export { tngTrusteeClientPlan } from "../../nebula/src/modules/k8s/trustee/client-plan.js";
export { trusteePolicies, type TrusteeSnpIdentity, type TrusteeResourcePath,
  type TrusteeResourceAdmission, type TrusteePolicies } from "../../nebula/src/modules/k8s/trustee/policies.js";
