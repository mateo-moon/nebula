import type { DeployPhase } from "../deploy";
import type { connectionSummary } from "./connection";
import type { OwnerApplicationContract } from "../application-approval";

export type StackSummary = ReturnType<typeof connectionSummary>;
export interface UiJob {
  id: string;
  action: "deploy" | "inspect";
  status: "running" | "succeeded" | "failed";
  phase: DeployPhase | "checking";
  error?: string;
  result?: Record<string, unknown>;
}
export interface Upload { name: string; base64: string }
export interface UiDeployInput {
  sourceImage: string;
  accessToken?: string;
  reviewed: boolean;
  applicationApproval: OwnerApplicationContract;
  registryAuth?: string;
  registryUsername?: string;
  registryPassword?: string;
  awsProfile?: string;
  volumeKeys?: Upload[];
  resourceFiles?: Upload[];
}
