import { gzipSync } from "node:zlib";
import { parse, stringify, type TomlTable } from "smol-toml";
import { sha256Hex } from "../confidential-guests/canonical";
import { initDataDocument, measuredGuest, type MeasuredArtifact } from "../confidential-guests/measured";
import { validateTrusteeAgentPolicy } from "./agent-policy";
import type { TrusteePodManifest } from "./manifests";
import { trusteePlan } from "./plan";
import { snpIdentity, trusteePolicies, type TrusteePolicies, type TrusteeSnpIdentity } from "./policies";
import { tngTrusteePlan } from "./tng-plan";
import type { TrusteeAgentPolicy, TrusteeConfig, TrusteePlan, TngTrusteeConfig, TngTrusteePlan } from "./types";

type GuestPlan = Pick<TrusteePlan, "pod" | "canonicalPodSha256">;

function initData(owner: string, plan: GuestPlan, reviewed: TrusteeAgentPolicy,
  guestConfig: Readonly<Record<string, string>>): MeasuredArtifact {
  if (reviewed.canonicalPodSha256 !== plan.canonicalPodSha256) throw new TypeError(`${owner}: Pod changed since policy generation`);
  validateTrusteeAgentPolicy(reviewed.policyRego);
  const document = stringify({ version: "0.1.0", algorithm: "sha256", data: {
    "policy.rego": reviewed.policyRego, ...guestConfig, "trustee.template.sha256": plan.canonicalPodSha256,
  } });
  const bytes = Buffer.from(document);
  const compressed = gzipSync(bytes, { level: 9 });
  compressed[9] = 255;
  return { canonicalPodSha256: plan.canonicalPodSha256, ccInitData: compressed.toString("base64"), initDataSha256: sha256Hex(bytes) };
}

function bindPolicy(owner: string, plan: GuestPlan, policy: MeasuredArtifact,
  guestConfig: Readonly<Record<string, string>>, mismatch: string): TrusteePodManifest {
  const pod = measuredGuest(plan.pod, policy);
  let document: TomlTable;
  try { document = parse(initDataDocument(policy.ccInitData).toString("utf8"), { unsafeKeyBehaviour: "throw" }); }
  catch { throw new TypeError(`${owner}: invalid native Init-Data document`); }
  const expected = { ...guestConfig, "trustee.template.sha256": plan.canonicalPodSha256 };
  const data = document.data;
  if (document.version !== "0.1.0" || document.algorithm !== "sha256" ||
      Object.keys(document).sort().join() !== "algorithm,data,version" ||
      !data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).sort().join() !== ["policy.rego", ...Object.keys(expected)].sort().join()) {
    throw new TypeError(`${owner}: ${mismatch}`);
  }
  const config = data as TomlTable;
  if (Object.entries(expected).some(([key, value]) => config[key] !== value)) throw new TypeError(`${owner}: ${mismatch}`);
  const policyRego = config["policy.rego"];
  if (typeof policyRego !== "string") throw new TypeError(`${owner}: ${mismatch}`);
  validateTrusteeAgentPolicy(policyRego);
  return pod;
}

/** Assemble native Init-Data after offline genpolicy generation and owner review. */
export function trusteeInitData(config: TrusteeConfig, reviewed: TrusteeAgentPolicy): MeasuredArtifact {
  const plan = trusteePlan(config);
  return initData("Trustee", plan, reviewed, { "aa.toml": plan.aaToml, "cdh.toml": plan.cdhToml });
}

export function tngTrusteeInitData(config: TngTrusteeConfig, reviewed: TrusteeAgentPolicy): MeasuredArtifact {
  const plan = tngTrusteePlan(config);
  return initData("TngTrustee", plan, reviewed, { "aa.toml": plan.aaToml });
}

export function bindTrusteePolicy(plan: TrusteePlan, policy: MeasuredArtifact): TrusteePodManifest {
  return bindPolicy("Trustee", plan, policy, { "aa.toml": plan.aaToml, "cdh.toml": plan.cdhToml },
    "Init-Data must bind the exact bootstrap HTTPS identity and native AA/CDH configuration");
}

export function bindTngTrusteePolicy(plan: TngTrusteePlan, policy: MeasuredArtifact): TrusteePodManifest {
  return bindPolicy("TngTrustee", plan, policy, { "aa.toml": plan.aaToml }, "unexpected InitData configuration");
}

/** Policies to install out of band on the independently controlled root KBS.
 * Never deploys or changes that authority; only this guest's exact pair is admitted. */
export function trusteeBootstrapPolicies(config: TrusteeConfig, policy: MeasuredArtifact,
  guest: Omit<TrusteeSnpIdentity, "initDataSha256">): TrusteePolicies {
  bindTrusteePolicy(trusteePlan(config), policy);
  const identity = snpIdentity({ ...guest, initDataSha256: policy.initDataSha256 });
  return trusteePolicies([config.bootstrap.tlsPrivateKey, config.bootstrap.tlsCertificate,
    ...config.resources.map(resource => resource.bootstrapPath)].map(path => ({ path, recipients: [identity] })));
}
