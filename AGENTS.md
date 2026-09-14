<!-- codex-managed-execution-policy:start -->
各 turn の最初の実作業前に `/Users/nichikatanaka/.codex/execution-policy.md` を読み、意味分類、browser surface、画面証跡、承認境界を適用する。
<!-- codex-managed-execution-policy:end -->
# Workspace Project Rules

- 未確定物は `work/`、提出物は `outputs/` に置く。既存の未関連変更を壊さず、必要最小限を変える。
- 案件の調査・修正・再開では、近い `STATE.md` / `Plan.md` / `AGENTS.md` / artifact の現在の依頼に関係する部分を先に読む。過去のcheckpointを現在の制約として再適用しない。単一URLの説明や無関係な小作業に案件全体の読込を足さない。

## AOSの業務実行

- 通常の求人応募は `direct_application` として現行Companion所有スレッドで進める。`codex_source_resume_authority.v1` / `implementation_allowed=false` は明示的な `source_return` にだけ適用し、通常応募の実行許可へ流用しない。
- AOSのWeb操作を行う時は [web-operation-profiles.md](docs/web-operation-profiles.md) の該当部分を使う。単発の目視操作は `UX-TRY`、登録・定期・再開可能workflowや同一runの業務証跡を求める操作は `RELEASE`。復旧の詳細記録は同文書のRELEASE向け項目を使う。
- 公式Chrome Plugin/Profile 2で接続・target readbackに失敗した場合だけ、再試行前に [chrome-plugin-stability](/Users/nichikatanaka/.codex/skills/chrome-plugin-stability/SKILL.md) と該当runbookを読む。共有transport owner、`chrome_operation_v1`、running-state guardの手順はそのSkillを正本とする。
