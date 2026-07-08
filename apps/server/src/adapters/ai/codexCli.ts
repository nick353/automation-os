export type CodexCliPlan = {
  adapter: "codex_cli";
  primary: true;
  command: string;
  notes: string[];
};

export function codexCliAdapter(prompt: string): CodexCliPlan {
  return {
    adapter: "codex_cli",
    primary: true,
    command: `codex exec --sandbox workspace-write ${JSON.stringify(prompt)}`,
    notes: [
      "Primary lane for local implementation and verification.",
      "Does not require an OpenAI API key.",
      "Use read-only sandbox for audits and workspace-write for controlled file changes."
    ]
  };
}
