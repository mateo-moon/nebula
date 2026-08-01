/**
 * Truthful health Lua for a CAPI + Crossplane substrate — overrides three
 * ArgoCD bundled assessments that read healthy runtime states as Degraded
 * (all three observed live as a permanently/flapping-Degraded cluster app
 * while every underlying object was fine):
 *
 * - MachineHealthCheck: bundled lua is `expectedMachines == currentHealthy
 *   else Degraded` — i.e. Degraded WHILE remediation works as designed. Truth:
 *   Degraded only when remediation is not allowed (short-circuited), else
 *   Progressing/Healthy.
 * - CAPI v1beta2 Cluster/MachineDeployment/Machine: bundled lua predates
 *   v1beta2 — no `Ready` condition there, and negative-polarity activity
 *   conditions (ScalingUp=False etc.) read as failures in a blind False-scan.
 *   Truth: key on `Available` (fall back `Ready`), treat activity conditions
 *   as Progressing only when True, Paused → Suspended.
 * - upbound MRs: bundled wildcard treats a sticky `LastAsyncOperation=False`
 *   (history of one failed async op, e.g. from a provider restart) as Degraded
 *   forever on an MR that is Ready=True. Truth: Ready wins; the async failure
 *   only matters while not Ready.
 *
 * Keys are `<group>/<Kind>` glob patterns for the `resource.customizations`
 * BLOB form — the only key form that accepts wildcards.
 */

const MHC_HEALTH_LUA = `
if obj.status == nil then
  return { status = "Progressing", message = "no status yet" }
end
for _, c in ipairs(obj.status.conditions or {}) do
  if c.type == "RemediationAllowed" and c.status == "False" then
    return { status = "Degraded", message = c.message or "remediation not allowed" }
  end
end
local expected = obj.status.expectedMachines or 0
local healthy = obj.status.currentHealthy or 0
if expected ~= healthy then
  return { status = "Progressing", message = healthy .. "/" .. expected .. " healthy; remediation in progress" }
end
return { status = "Healthy", message = "" }
`;

const CAPI_AVAILABLE_HEALTH_LUA = `
if obj.metadata ~= nil and obj.metadata.deletionTimestamp ~= nil then
  return { status = "Progressing", message = "deleting" }
end
if obj.spec ~= nil and obj.spec.paused == true then
  return { status = "Suspended", message = "spec.paused" }
end
local activity = {
  ScalingUp = true, ScalingDown = true, Remediating = true,
  RollingOut = true, Updating = true, Deleting = true,
}
local conds = (obj.status ~= nil and obj.status.conditions) or {}
local busy = {}
for _, c in ipairs(conds) do
  if c.type == "Paused" and c.status == "True" then
    return { status = "Suspended", message = c.message or "paused" }
  end
  if activity[c.type] and c.status == "True" then
    table.insert(busy, c.type)
  end
end
local keyed = nil
for _, c in ipairs(conds) do
  if c.type == "Available" then keyed = c end
end
if keyed == nil then
  for _, c in ipairs(conds) do
    if c.type == "Ready" then keyed = c end
  end
end
if keyed == nil then
  return { status = "Progressing", message = "waiting for Available condition" }
end
if keyed.status == "True" then
  return { status = "Healthy", message = "" }
end
if #busy > 0 then
  return { status = "Progressing", message = "not available: " .. table.concat(busy, ", ") }
end
return { status = "Degraded", message = keyed.message or keyed.reason or "not available" }
`;

const UPBOUND_MR_HEALTH_LUA = `
local conds = (obj.status ~= nil and obj.status.conditions) or {}
local ready, synced, asyncFailed = nil, nil, nil
for _, c in ipairs(conds) do
  if c.type == "Ready" then ready = c end
  if c.type == "Synced" then synced = c end
  if c.type == "LastAsyncOperation" and c.status == "False" then asyncFailed = c end
end
if ready ~= nil and ready.status == "True" then
  return { status = "Healthy", message = "" }
end
if asyncFailed ~= nil then
  return { status = "Degraded", message = asyncFailed.message or "async operation failed" }
end
if synced ~= nil and synced.status == "False" then
  return { status = "Degraded", message = synced.message or "not synced" }
end
return { status = "Progressing", message = "waiting for Ready" }
`;

/**
 * Every upbound kind the estate runs, as EXACT `group/Kind` entries. Exact
 * keys win ArgoCD's FIRST override lookup; wildcard-vs-wildcard resolution
 * (ours vs the bundled `*.upbound.io/*`) iterates an unordered map — observed
 * live: the running controller kept picking the bundled Lua for Instances
 * (sticky-LastAsyncOperation Degraded) while `argocd admin settings
 * resource-overrides health` picked ours. The wildcard stays as the
 * catch-all for kinds this list misses; future families are pre-listed
 * (entries for absent CRDs are inert).
 */
const UPBOUND_EXACT_KINDS = [
  "ec2.aws.upbound.io/EBSVolume",
  "ec2.aws.upbound.io/EIP",
  "ec2.aws.upbound.io/EIPAssociation",
  "ec2.aws.upbound.io/Instance",
  "ec2.aws.upbound.io/InternetGateway",
  "ec2.aws.upbound.io/NATGateway",
  "ec2.aws.upbound.io/Route",
  "ec2.aws.upbound.io/RouteTable",
  "ec2.aws.upbound.io/RouteTableAssociation",
  "ec2.aws.upbound.io/SecurityGroup",
  "ec2.aws.upbound.io/SecurityGroupEgressRule",
  "ec2.aws.upbound.io/SecurityGroupIngressRule",
  "ec2.aws.upbound.io/SecurityGroupRule",
  "ec2.aws.upbound.io/Subnet",
  "ec2.aws.upbound.io/VPC",
  "ec2.aws.upbound.io/VolumeAttachment",
  "iam.aws.upbound.io/InstanceProfile",
  "iam.aws.upbound.io/Policy",
  "iam.aws.upbound.io/Role",
  "iam.aws.upbound.io/RolePolicyAttachment",
  "route53.aws.upbound.io/Record",
  "route53.aws.upbound.io/Zone",
  "s3.aws.upbound.io/Bucket",
  "kms.aws.upbound.io/Key",
  "kms.aws.upbound.io/Alias",
  "servicequotas.aws.upbound.io/ServiceQuota",
  "dlm.aws.upbound.io/LifecyclePolicy",
];

/** Drop-in for {@link ArgoCdConfig.resourceHealthChecks}. */
export const CAPI_CROSSPLANE_HEALTH_LUA: Record<string, string> = {
  "cluster.x-k8s.io/MachineHealthCheck": MHC_HEALTH_LUA,
  "cluster.x-k8s.io/Cluster": CAPI_AVAILABLE_HEALTH_LUA,
  "cluster.x-k8s.io/MachineDeployment": CAPI_AVAILABLE_HEALTH_LUA,
  "cluster.x-k8s.io/Machine": CAPI_AVAILABLE_HEALTH_LUA,
  "*.aws.upbound.io/*": UPBOUND_MR_HEALTH_LUA,
  ...Object.fromEntries(
    UPBOUND_EXACT_KINDS.map((k) => [k, UPBOUND_MR_HEALTH_LUA]),
  ),
};
