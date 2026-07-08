import { RunContract } from "./runContracts.js";

export type Proof = {
  proofType: string;
  label: string;
  uri: string;
  metadata?: Record<string, unknown>;
};

export type ProofEvaluation = {
  ok: boolean;
  missing: string[];
  present: string[];
};

export const dailyAiRequiredProofs = [
  "source_collection",
  "x_publish",
  "linkedin_publish",
  "engagement",
  "postflight_sync",
  "buffer_refresh",
  "cleanup"
];

export function evaluateProofGate(proofs: Proof[], requiredProofs = dailyAiRequiredProofs): ProofEvaluation {
  const present = new Set(proofs.map((proof) => proof.proofType));
  const missing = requiredProofs.filter((proofType) => !present.has(proofType));
  return {
    ok: missing.length === 0,
    missing,
    present: [...present]
  };
}

export function evaluateRunContractProofGate(contract: Pick<RunContract, "requiredProofs">, proofs: Proof[]): ProofEvaluation {
  const present = new Set(proofs.map((proof) => proof.proofType));
  const contractPresent = contract.requiredProofs.filter((proofType) => present.has(proofType));
  const missing = contract.requiredProofs.filter((proofType) => !present.has(proofType));
  return {
    ok: missing.length === 0,
    missing,
    present: contractPresent
  };
}

export function summarizeProofGate(evaluation: ProofEvaluation): string {
  if (evaluation.ok) return "complete: all required proof types are present";
  return `partial: missing ${evaluation.missing.join(", ")}`;
}
