export type CodexAppAdapter = {
  adapter: "codex_app";
  primary: true;
  importMode: "read_only";
  assetRoots: string[];
};

export function codexAppAdapter(): CodexAppAdapter {
  return {
    adapter: "codex_app",
    primary: true,
    importMode: "read_only",
    assetRoots: [
      "/Users/nichikatanaka/.codex/automations",
      "/Users/nichikatanaka/.codex/sessions",
      "/Users/nichikatanaka/.codex/skills",
      "/Users/nichikatanaka/.agents/skills",
      "/Users/nichikatanaka/.codex/plugins/cache"
    ]
  };
}
