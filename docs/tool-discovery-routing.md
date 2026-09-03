# Tool discovery and routing

## Purpose

Automation OSのChatから作成するautomationは、会社scopeを固定したうえで、利用可能な実行候補を次のように評価する。

1. Plugin
2. MCP / CLI / API（同率2位）

同率2位の中では、依頼への適合度、会社scopeでの検証済み状態、fresh readbackを使う。Pluginが未認証の場合は、MCP・CLI・APIへ黙って切り替えず、`needs_company_auth`を次の確認として返す。これは認証済みアカウントで別会社のデータを読まないための境界である。

## Discovery sources

The local inventory is the runtime source of truth.  Public research is used to
identify candidates and their supported authentication shape; it does not make
a candidate installed, enabled, connected, or company-authorized.

- OpenAI plugin architecture: <https://developers.openai.com/plugins/concepts/plugins>
  - A plugin can package Skills, an MCP server, or both.
  - MCP authentication and tool schemas belong to the server/connector layer.
- MCP authorization and discovery: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
  - HTTP MCP clients discover authorization servers through protected-resource
    metadata and must validate the discovered issuer before using it.
- Google Workspace remote MCP: <https://developers.google.com/workspace/guides/configure-mcp-servers>
  - Gmail, Drive, Docs, Sheets, Slides, Calendar, and Chat have documented
    remote MCP endpoints. Their OAuth configuration is provider/client-side,
    not an AOS token store.
- Supabase Remote MCP: <https://supabase.com/changelog/39434-supabase-remote-mcp-server>
  - Supabase exposes a remote MCP entry point; AOS should delegate its
    connector execution to the Codex/MCP layer and retain only company-scoped
    non-secret references and same-run receipts.

## Runtime contract

`automation_os_tool_preference.v1` is generated from the fresh local Codex
inventory, the company connection references, and the repository's reviewed
official-catalog candidates. It records the selected candidate,
candidate status, company IDs, precedence, and the explicit
`no_implicit_fallback` policy. It never contains access tokens, refresh tokens,
cookies, OAuth client secrets, or raw provider credentials.

The catalog screen is intentionally truthful:

- installed/inventory-only is not the same as connected;
- the page also shows recommended Plugins that are not installed yet as
  `catalog_available`; these cards expose an install hint only and never
  pretend that the Plugin is installed or company-authenticated;
- a company connection reference is not the same as provider-side OAuth
  completion;
- a verified connection is only usable when its company ID is bound to the
  current Chat/Run;
- public research candidates remain catalog candidates until local inventory,
  provider verification, and company binding are read back.

## Connector execution placement

For Gmail, Supabase, Drive, Calendar, and similar connector work, the
connected Zeabur Codex App Server is the preferred execution owner. A Plugin
must be installed in that server's registry and its connector authentication
must be verified for the current company before the placement becomes
`zeabur_codex_app_server` / `ready`. A direct MCP registry entry is read back
separately; an empty direct MCP list does not turn an installed Plugin into a
verified connector.

The Mac Worker default surface is Chrome Plugin / Profile 2. If the Zeabur
placement is unavailable, AOS records the exact blocker and does not
implicitly move Gmail or Supabase to Mac. A Mac connector route exists only as
an explicit fallback in the Run admission.

The current reviewed catalog includes Google Workspace remote MCP candidates for
Gmail, Drive, and Calendar, plus Supabase Remote MCP. These are discovery
records only; the live runtime still requires the corresponding Codex connector
or MCP entry to be installed, enabled, authenticated, and verified.

The Gmail read-only canary is an admission readback only. It checks the
company-scoped connection reference, Plugin-first selection, Codex App Server,
and MCP verification, while asserting `external_action_executed=false`,
`dataRead=false`, and `dataPersisted=false`. It does not call Gmail or issue a
provider receipt.

## Next research stage

The next safe extension is a periodic, read-only catalog refresh that records
candidate name, source URL, transport, supported auth discovery, required
scopes, version, and verification timestamp. It must not install a plugin,
start OAuth, read a secret, or enable a provider automatically.
