import type { ProjectRegistry } from "./projectAuditor.js";

export function buildDefaultProjectRegistry(): ProjectRegistry {
  return {
    schema_version: 1,
    updated_at: "2026-06-23",
    policy: {
      default_surface: "read_first_locator_only",
      safe_auto_fix: [
        "obsidian_export",
        "generated_markdown_refresh",
        "generated_context_pack_cleanup",
        "state_template_scaffold",
        "link_existence_audit",
        "proof_pointer_readback",
        "local_status_json_write"
      ],
      approval_required_fix: [
        "external_api_write",
        "google_sheets_write",
        "social_post_publish",
        "job_submit",
        "etsy_listing_publish",
        "github_push",
        "deploy",
        "delete",
        "external_service_settings_change",
        "secret_change"
      ],
      human_only: [
        "billing",
        "purchase",
        "payment",
        "checkout",
        "paid_subscription",
        "invoice",
        "captcha",
        "otp",
        "security_code",
        "identity_verification"
      ]
    },
    projects: [
      {
        id: "local-codex",
        label: "Local Codex",
        root: "/Users/nichikatanaka/.codex",
        owner_layer: "operator_layer",
        obsidian: true,
        authority_files: ["STATE.md", "AGENTS.md", "config.toml"],
        artifact_roots: ["sessions", "memories", "automations", "hooks"],
        source_of_truth: [
          "/Users/nichikatanaka/.codex/STATE.md",
          "/Users/nichikatanaka/.codex/AGENTS.md",
          "/Users/nichikatanaka/AGENTS.md",
          "/Users/nichikatanaka/.agents/skills/",
          "/Users/nichikatanaka/.codex/memories/"
        ],
        related_projects: ["automation-os", "new-project", "etsy", "apparel-ai-workspace"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["secret_change", "external_service_settings_change", "delete", "deploy"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/local-codex.md"
      },
      {
        id: "automation-os",
        label: "Automation OS",
        root: "/Users/nichikatanaka/Documents/Codex/automation-os",
        owner_layer: "control_plane",
        obsidian: true,
        authority_files: ["STATE.md", "package.json", "docs/13-project-boundary-standard.md", "data/project-registry.json"],
        artifact_roots: ["artifacts", "data/artifacts", "data/obsidian-export-status.json", "data/project-audit-status.json"],
        source_of_truth: [
          "/Users/nichikatanaka/Documents/Codex/automation-os/STATE.md",
          "/Users/nichikatanaka/Documents/Codex/automation-os/data/automation-os.sqlite",
          "/Users/nichikatanaka/Documents/Codex/automation-os/data/obsidian-export-status.json",
          "/Users/nichikatanaka/Documents/Codex/automation-os/data/project-registry.json"
        ],
        related_projects: ["local-codex", "new-project", "etsy", "apparel-ai-workspace", "prompt-transfer", "prompt-transfer-ukiyoe"],
        allowed_automation: ["safe_auto_fix", "read_only_audit", "obsidian_export"],
        approval_required: ["github_push", "deploy", "delete", "external_service_settings_change", "secret_change"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/automation-os.md"
      },
      {
        id: "new-project",
        label: "Daily AI / Job automations",
        root: "/Users/nichikatanaka/Documents/New project",
        owner_layer: "project_workspace",
        obsidian: true,
        authority_files: ["STATE.md", "AGENTS.md", "README.md", "posting_queue.tsv"],
        artifact_roots: ["artifacts", "artifacts/run-summaries", "artifacts/playwright-cli-runs"],
        source_of_truth: [
          "/Users/nichikatanaka/Documents/New project/STATE.md",
          "/Users/nichikatanaka/Documents/New project/posting_queue.tsv",
          "/Users/nichikatanaka/Documents/New project/artifacts/"
        ],
        related_projects: ["automation-os", "local-codex"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["social_post_publish", "job_submit", "google_sheets_write", "external_api_write", "delete"],
        human_only: ["billing", "purchase", "payment", "checkout", "captcha", "otp", "security_code", "identity_verification"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/new-project.md"
      },
      {
        id: "etsy",
        label: "NisenPrints / Etsy",
        root: "/Users/nichikatanaka/Documents/Etsy",
        owner_layer: "project_workspace",
        obsidian: true,
        authority_files: ["STATE.md"],
        artifact_roots: ["artifacts", "artifacts/publish_manifests", "artifacts/publish_proofs", "artifacts/manual_checks", "artifacts/playlite-runs"],
        source_of_truth: [
          "/Users/nichikatanaka/Documents/Etsy/STATE.md",
          "/Users/nichikatanaka/Documents/Etsy/artifacts/publish_manifests/",
          "/Users/nichikatanaka/Documents/Etsy/artifacts/publish_proofs/",
          "/Users/nichikatanaka/.agents/skills/etsy-pinterest-poster/SKILL.md"
        ],
        related_projects: ["automation-os", "local-codex"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["etsy_listing_publish", "social_post_publish", "external_api_write", "delete"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/etsy.md"
      },
      {
        id: "apparel-ai-workspace",
        label: "Apparel AI Workspace",
        root: "/Users/nichikatanaka/Desktop/アパレル１",
        owner_layer: "project_workspace",
        obsidian: true,
        authority_files: ["STATE.md", "README.md", "package.json", "zeabur.json"],
        artifact_roots: ["output", "test-results", "docs", "screenshots"],
        source_of_truth: [
          "/Users/nichikatanaka/Desktop/アパレル１/STATE.md",
          "/Users/nichikatanaka/Desktop/アパレル１/src/",
          "/Users/nichikatanaka/Desktop/アパレル１/supabase/",
          "/Users/nichikatanaka/Desktop/アパレル１/output/"
        ],
        related_projects: ["automation-os", "apparel-heavy-chain", "local-codex"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["deploy", "external_service_settings_change", "secret_change", "delete"],
        human_only: ["billing", "purchase", "payment", "checkout", "paid_subscription"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/apparel-ai-workspace.md"
      },
      {
        id: "apparel-heavy-chain",
        label: "Apparel Heavy Chain",
        root: "/Users/nichikatanaka/Desktop/アパレル１/heavy-chain",
        owner_layer: "locator_only_subdirectory",
        obsidian: true,
        authority_files: ["STATE.md"],
        artifact_roots: ["artifacts", "output", "screenshots"],
        source_of_truth: ["/Users/nichikatanaka/Desktop/アパレル１/STATE.md"],
        related_projects: ["apparel-ai-workspace", "automation-os"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["deploy", "external_service_settings_change", "secret_change", "delete"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/apparel-heavy-chain.md"
      },
      {
        id: "prompt-transfer",
        label: "Prompt Transfer",
        root: "/Users/nichikatanaka/.agents/skills/prompt-transfer",
        owner_layer: "skill_workspace",
        obsidian: true,
        authority_files: ["STATE.md", "SKILL.md"],
        artifact_roots: ["artifacts/runs"],
        source_of_truth: [
          "/Users/nichikatanaka/.agents/skills/prompt-transfer/STATE.md",
          "/Users/nichikatanaka/.agents/skills/prompt-transfer/SKILL.md",
          "/Users/nichikatanaka/.agents/skills/prompt-transfer/artifacts/runs/"
        ],
        related_projects: ["prompt-transfer-ukiyoe", "local-codex", "automation-os"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["google_sheets_write", "external_api_write", "delete", "secret_change"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/prompt-transfer.md"
      },
      {
        id: "prompt-transfer-ukiyoe",
        label: "Prompt Transfer Ukiyoe",
        root: "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe",
        owner_layer: "skill_workspace",
        obsidian: true,
        authority_files: ["STATE.md", "SKILL.md", "scripts/run_prompt_transfer_ukiyoe_playwright_sheets.py"],
        artifact_roots: ["artifacts/runs"],
        source_of_truth: [
          "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe/STATE.md",
          "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe/SKILL.md",
          "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe/artifacts/runs/"
        ],
        related_projects: ["prompt-transfer", "local-codex", "automation-os"],
        allowed_automation: ["safe_auto_fix", "read_only_audit"],
        approval_required: ["google_sheets_write", "external_api_write", "delete", "secret_change"],
        human_only: ["billing", "purchase", "payment", "checkout"],
        context_pack: "/Users/nichikatanaka/Documents/Obsidian Vault/05_Projects/Generated Context Packs/prompt-transfer-ukiyoe.md"
      }
    ]
  };
}
