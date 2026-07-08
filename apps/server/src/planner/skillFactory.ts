import { makeId, nowIso } from "../db/client.js";

export type SkillDraft = {
  id: string;
  runId: string;
  name: string;
  markdown: string;
  createdAt: string;
};

export function createSkillDraft(input: {
  runId: string;
  runName: string;
  steps: Array<{ name: string; status: string }>;
  proofs: Array<{ proofType: string; label: string }>;
}): SkillDraft {
  const slug = input.runName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const successfulSteps = input.steps.filter((step) => step.status === "completed");
  const proofList = input.proofs.map((proof) => `- ${proof.proofType}: ${proof.label}`).join("\n");
  const stepList = successfulSteps.map((step) => `- ${step.name}`).join("\n");
  return {
    id: makeId("skill"),
    runId: input.runId,
    name: `${slug || "automation"}-reusable-skill`,
    createdAt: nowIso(),
    markdown: `---\nname: ${slug || "automation"}-reusable-skill\ndescription: Reusable draft generated from Automation OS run ${input.runId}.\n---\n\n# ${input.runName}\n\nUse this skill when the same automation pattern should be repeated with strict lane isolation, approval grouping, and proof capture.\n\n## Steps\n${stepList || "- No completed steps captured yet."}\n\n## Required Proof\n${proofList || "- Add proof receipts before promoting this draft."}\n\n## Lane Rules\n- Allocate a separate Playwright profile, CDP port, and workdir per task.\n- Keep Codex App assets read-only.\n- Use approval_group_id and resource_locks for dangerous commits.\n`
  };
}
