# Automation OS

Automation OS is a local control surface for recurring automation work across Codex, Obsidian, the canonical Browser Use CLI, and project-specific connectors. Its job is to answer three questions quickly: what is running, what is blocked, and what proof exists.

The repository contains the app, server, workflow contracts, docs, and local runner glue. It does not contain live SQLite databases, browser profiles, artifacts, logs, screenshots, API keys, OAuth tokens, or personal execution state.

## Current Shape

- `apps/server` exposes the local API, workflow registry, worker engine, proof gates, Obsidian ingest/export, and runner adapters.
- `apps/web` is the local dashboard for sources, runs, approvals, and actionable next steps.
- `docs` records architecture, roadmap, Codex app parity, local worker rules, and Obsidian export design.
- `scripts` contains local wrappers for development, the canonical Browser Use CLI boundary, and connector-only workflows.
- `STATE.md` is the human-readable project state. Runtime truth lives in the configured database, plus workflow-owned artifacts.
- `docs/RECOVERY_RUNBOOK.md` is the recovery entrypoint for moving AOS to another server, reconnecting the optional Codex App Server, and moving the Browser Use worker to another Mac.

## Local Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
npm run dev
```

The default server port is `8787`. The dev script starts the local server and web UI together.

## 初めてのWeb操作（固定化しない共通入口）

Home の「Web操作の共通入口」または Chat を開き、次のように自然文で依頼します。サイトごとのCSS selector、XPath、DOM順、スクショ名、固定クリック手順を指定する必要はありません。

```text
目的: read / create / update / publish / submit / delete のどれか
サイトまたはURL:
会社とアカウント:
対象（意味で指定。例: 公開、保存、応募、削除）:
内容（本文・画像・ファイル・応募内容など）:
公開先・送信先・対象範囲:
```

Home/Chatの共通入口から始めると、この6項目がChat入力欄へ下書きとして自動入力されます。空欄を埋めてから送信してください。plannerは同じ入力から共通Web操作インテークを作り、不足項目・固定locator拒否・readまたはapproval待ちを明示します。テンプレートは操作を開始せず、plannerのreadbackも操作を開始しません。外部操作は承認・同一Runのprovider/source readback・reconciliation・cleanupが揃うまで完了扱いにしません。

Automation OS は現在の画面を読み、意味（role、label、状態、URL、候補の一意性）で対象を解決します。画面変更、モーダル、スクロール、ページング、認証状態の変化があれば再評価します。候補が見つからない・複数ある・未知の高影響質問がある場合は停止して質問し、古い証拠から再実行しません。

公開URLを開いた時、管理画面はprivate ingressまたはSSOの確認後にサーバーが発行するHttpOnly・Secure・SameSite cookieで保護されます。管理者用APIキーの手入力は不要です。read/write tokenとautomation-3専用service identityはSecret StoreまたはKeychainからサーバー/worker側だけが取得し、ブラウザ、チャット本文、URL、localStorage、sessionStorage、録画、artifactへ渡しません。private ingress/SSOが未設定なら `private_ingress_or_sso_required` でfail-closedします。

読み取り以外の投稿・公開・応募・送信・更新・削除は、会社scope、account、具体的なtarget、payload、fresh authority、明示承認を同一Runへ束縛します。実行後も同一Runのprovider receipt、source-of-truth sync、cleanupが揃うまで完了扱いにしません。パスワード、cookie、token、OTP、CAPTCHAを保存・表示することはありません。

Browser Use CLI が遅く見えていた主因は、論理コマンドごとにCLIプロセスを起動し、各コマンドの後にnavigation/frame/state証跡を直列で取りに行っていたことです。読み取り専用のbounded batchは同一プロセスで処理し、外部効果のある操作は安全境界を保つため個別の承認・readback・cleanup laneに分けています。これにより、read-only batchの証跡を保ったまま起動オーバーヘッドを減らします。

### Codex App Server Probe

`AUTOMATION_OS_CODEX_APP_SERVER_PROBE_ENABLED` defaults to `0`. When set to `1`, `POST /api/codex/app-server/probe` performs a bounded stdio initialize-only read-only probe.

The connection boundary supports two explicit modes:

- No remote URL: `local_stdio` remains the safe Mac fallback.
- `AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL=wss://...` plus
  `AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN`: use the authenticated remote
  WebSocket lane. Non-loopback `ws://`, URL query credentials, missing auth,
  and invalid remote cwd fail closed; they never silently fall back to local.
- Zeabur AOS only may explicitly use
  `ws://codex-app-server.zeabur.internal:8080/` with
  `AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS=1` for the private
  service-to-service canary. This exact internal host is rejected unless the
  flag is present; do not use it from the Mac worker or Mac Codex App. Browser
  Use, LinkedIn, iPhone/Simulator, Obsidian, and local files remain Mac-only.

`GET /api/codex/app-server/readiness` is a protected, read-only status check.
It reports `/readyz` for a configured remote endpoint but does not start a
thread or turn. The dedicated Zeabur service template is in
`ops/zeabur/`; its public route must be `wss://` with TLS termination and
WebSocket upgrade forwarding. The official WebSocket transport is currently
experimental and unsupported for production workloads, so deployment,
secret injection, and fresh `initialize`/`thread/start`/read-only
`turn/start` completion evidence remain separate promotion gates.

For a remote deployment, the official guidance is to keep the App Server
behind SSH, a VPN/mesh, or another private boundary rather than exposing the
transport directly on a shared/public network. A Zeabur `wss://` route is
therefore a technical canary only until that boundary and the official support
status are approved. Zeabur cannot perform Mac-owned Browser Use CLI flows,
iPhone or Simulator operations, Obsidian vault access, or local file work;
those remain on the Mac worker.

Tune the probe with:

```bash
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND=codex
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TIMEOUT_MS=1500
AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TTL_MS=30000
```

A successful probe only refreshes capability inventory. It still leaves `appServer.state.connected=false`, and it is not authority, external action, or completion proof.

For a fresh host, run `npm run recovery:preflight`, then
`npm run codex:server:source-preflight`. The dedicated Codex App Server source
can be staged with `npm run codex:server:stage -- --output <absolute-stage-dir>`;
the stage contains no credential. Follow
`docs/RECOVERY_RUNBOOK.md` for the secret-manager, persistent `CODEX_HOME`,
private-route, and AOS connection settings.

## Production Safety

Public deployments must be treated as private operator control surfaces. All `/api/*` routes except health and the session bootstrap route remain protected by default. The UI session is issued only after a trusted private ingress proof or SSO boundary; state-changing calls still require a write-scoped session. `AUTOMATION_OS_READ_TOKEN`, `AUTOMATION_OS_WRITE_TOKEN`, and the dedicated automation-3 service identity are resolved server-side from Secret Store, owner-only files, or Keychain. Do not disable either guard on a publicly reachable service.

PostgreSQL is the preferred production database. Create a PostgreSQL service in the host, then set one of these variables on the Automation OS service:

```bash
DATABASE_URL=<postgres connection string>
# or
AUTOMATION_OS_DATABASE_URL=<postgres connection string>
```

On Zeabur, add a Database -> PostgreSQL service, then set `DATABASE_URL=${POSTGRES_URI}` in the Automation OS service Variables tab.

The Create chat uses `/api/create/plan` as its planner backend. By default, local Mac runs use the installed Codex CLI subscription path, while production-like hosts fall back to the local planner so the app can boot, test, and deploy without OpenAI API billing. Set `AUTOMATION_OS_CREATE_PLANNER_PROVIDER=openai` only when API billing is acceptable; then `OPENAI_API_KEY` and optional `OPENAI_PLANNER_MODEL` are used.

When either variable is set, Automation OS initializes and uses PostgreSQL. When neither is set, it falls back to SQLite. For a temporary SQLite production fallback, use an explicit persistent database path:

```bash
AUTOMATION_OS_DB=/data/automation-os.sqlite
AUTOMATION_OS_REQUIRE_WRITE_TOKEN=1
AUTOMATION_OS_REQUIRE_API_TOKEN=1
AUTOMATION_OS_WRITE_TOKEN=<set in the host secret manager>
# Set one read-only token in the host secret manager for authenticated QA/replay
# readback. The value must never be committed or pasted into chat.
AUTOMATION_OS_READ_TOKEN=<set in the host secret manager>
```

`npm run qa:production` and `npm run qa:production:replay` look for
`AUTOMATION_OS_READ_TOKEN`, `AUTOMATION_OS_QA_READ_TOKEN`, then
`AUTOMATION_OS_REPLAY_READ_TOKEN`. If none is injected into the QA process,
the exact blocker is `production_read_token_missing`; the tools do not guess a
write token or bypass the protected API.
When the read token is absent or invalid, these commands still check public
health but do not contact protected routes; they record the exact blocker
without repeatedly generating unauthenticated 401 requests.

For a long-lived local QA/launch boundary, prefer the corresponding file
variables (`AUTOMATION_OS_READ_TOKEN_FILE`,
`AUTOMATION_OS_QA_READ_TOKEN_FILE`, or
`AUTOMATION_OS_REPLAY_READ_TOKEN_FILE`). The file must be an absolute,
owner-only (0400/0600), non-symlink, single-link regular file owned by the
current user. The token value and file path are not written to readback
artifacts; an invalid file remains fail-closed with an exact blocker.

To copy an existing SQLite database into an empty PostgreSQL database, run this from a trusted local shell. The confirmation variable is intentional because the target PostgreSQL tables are replaced:

```bash
AUTOMATION_OS_SQLITE_SOURCE=./data/automation-os.sqlite \
DATABASE_URL=<postgres connection string> \
AUTOMATION_OS_CONFIRM_POSTGRES_MIGRATION=1 \
npm run db:migrate:postgres
```

Rollback is configuration-only: remove `DATABASE_URL` / `AUTOMATION_OS_DATABASE_URL` from the Automation OS service and redeploy to return to SQLite. If rolling back after a PostgreSQL write window, export or inspect the PostgreSQL rows first so new production state is not silently abandoned.

After every deployment, run:

```bash
npm run qa:production -- https://automation-os.zeabur.app
```

This checks the public JSON APIs. Browser/UI QA must use a fresh, same-run canonical Browser Use CLI authority/profile/port and recording proof; if that surface is unavailable, QA stops with an exact blocker rather than falling back to Playwright, direct Chrome, CDP, or the Codex in-app browser.

## Git Boundary

The following are intentionally ignored:

- `data/`, including SQLite databases, `resume-contract.json`, secret store files, and local run state.
- `artifacts/`, `output/`, `logs/`, `test-results/`, and browser session folders.
- `.env` files and private key material.

Before publishing or pushing, run a secret scan against the staged files and verify that only source code, docs, package manifests, and safe templates are included.

`lint_not_configured`: there is no dedicated repo lint script. Use `npm run build`, `npm run typecheck:web`, and `npm test` as the maintained verification set.

`dedicated_secret_scanner unavailable`: use a bounded grep-based secret scan against the changed files instead of a missing workspace scanner.

## Operating Rules

Generated Obsidian pages and handoff notes are locators, not proof. Before resuming work, read `data/resume-contract.json`, the Obsidian handoff index/current-work notes, then this repository's `STATE.md`, DB rows, and latest workflow artifacts.

Browser Use CLI is the only permitted Automation OS browser surface. Every browser-backed adapter must either call the canonical helper through the shared flow adapter with fresh authority/profile/port, same-session readback, and cleanup proof, or fail closed with `browser_use_cli_required` / `browser_use_cli_workflow_adapter_missing`. Playwright, direct Chrome, direct CDP, extension-backed browser lanes, and Codex in-app browser fallbacks are retired from registered automation execution.

Billing, purchase, payment, checkout, paid subscription, invoice, or billing-equivalent screens are the hard stops. Non-billing post, publish, submit, send, save, and in-scope delete actions require workflow-owned evidence and readback rather than a generic approval stop.
