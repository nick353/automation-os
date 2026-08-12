# Zeabur Codex App Server lane

This directory prepares a separate Zeabur service for the official Codex App
Server WebSocket transport. Automation OS remains the control plane and keeps
local stdio as the fallback until a fresh remote readback is complete.

This is a technical-canary lane only. A successful `/readyz` or authenticated
`initialize` does not authorize production cutover: the current official
WebSocket transport is experimental and unsupported for production workloads.
The AOS readiness/probe readback therefore exposes
`production_ready=false` / `productionRemoteCutoverAllowed=false` until the
official support boundary changes and the full same-run thread/turn evidence
is available.

The official remote-connection guidance prefers SSH, a VPN/mesh, or another
private boundary. A public Zeabur `wss://` route is only a technical canary and
must not be treated as the production transport while the WebSocket support
boundary remains experimental.

Zeabur Private Networking is service-to-service communication inside the same
project; it is not a route reachable directly from the Mac worker. Therefore a
Mac AOS client must use an approved SSH/VPN/mesh path that reaches the private
service, or an explicitly approved TLS-terminated `wss://` ingress. Do not put
the Zeabur internal hostname into the Mac remote URL and call that reachability
proof.

## Service boundary

- Dedicated service: build with `ops/zeabur/Dockerfile.codex-app-server`.
- Container listener: loopback `ws://127.0.0.1:4500` by default (or
  `CODEX_APP_SERVER_PORT`). A non-loopback bind requires both
  `CODEX_APP_SERVER_NON_LOOPBACK_APPROVED=1` and
  `CODEX_APP_SERVER_TLS_TERMINATED=1`.
- Public connector: must be `wss://` with Zeabur TLS termination and WebSocket
  upgrade forwarding. Do not expose a non-loopback `ws://` endpoint.
- Authentication: `CODEX_APP_SERVER_TOKEN_FILE` must point to a private file
  mounted by the Zeabur secret manager. The entrypoint passes only the file
  path to the process; the token value is never placed in argv, logs,
  artifacts, or the image.
- Secret-file reference: `codex-app-server-config-reference.yaml` is a
  credential-free Config Editor/template fragment. It uses Zeabur's documented
  `configs` + `envsubst` + decimal permission `256` (0400) to materialize the
  approved token into `/run/secrets/codex-app-server-token`. It is only a
  candidate boundary until the target service proves secret non-exposure and
  runtime permission/readiness; it does not contain or create a real token.
- The image installs `ca-certificates` for Codex upstream TLS validation. Do
  not disable certificate verification to work around a missing or invalid
  trust chain.
- The build invokes APT with `APT::Sandbox::User=root` because this Docker
  builder's unprivileged `_apt` method falsely rejects otherwise valid Debian
  InRelease signatures. APT signature and TLS verification remain enabled;
  this build-time setting does not weaken the runtime Codex bubblewrap sandbox.
- The image uses `/app` as its working directory because AOS binds the
  read-only remote `cwd` to `/app` for `thread/start` and `turn/start`.
- Persistent Codex state: mount the approved volume at `CODEX_HOME` and supply
  the approved Codex authentication in that service boundary. This repository
  does not create, copy, or print credentials.
- Automation OS: set the remote URL/token only after the endpoint and secret
  have been approved. AOS accepts either the existing environment variable
  `AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN` or a secret-manager file at
  `AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_TOKEN_FILE`; file auth requires an
  absolute, regular, owner-only file and never appears in readback. The AOS
  readiness route is read-only and does not start a thread or turn.
- Zeabur-only internal bridge: the AOS service may set
  `AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL=ws://codex-app-server.zeabur.internal:8080/`
  together with `AUTOMATION_OS_CODEX_APP_SERVER_ALLOW_INTERNAL_WS=1`. The
  implementation accepts this exact dedicated-service hostname only; it does
  not permit public plaintext WebSockets or any other internal service. This
  flag is for the Zeabur AOS service only and must not be copied to the Mac
  worker or Mac Codex App. The transport remains an experimental technical
  canary and is never a browser/Web-operation lane.

## Fresh promotion gates

1. Build the image and observe the dedicated service process and local `/readyz`.
2. Verify the public route is `wss://`, the backend port is not directly
   reachable, auth is enabled, and no token appears
   in deployment logs or service variables exposed to ordinary readback.
3. Configure the AOS remote variables through the approved secret boundary;
   for the Zeabur-only route, use the private service URL and explicit
   internal-WebSocket flag above. Do not expose the token value in a variable
   readback or artifact.
4. Read `GET /api/codex/app-server/readiness` from AOS and confirm both the
   technical result and the production promotion fields.
5. Run `POST /api/codex/app-server/probe` and verify fresh WebSocket
   `initialize` readback.
6. Run a read-only `thread/start`, `turn/start`, and `turn/completed` canary
   with no Browser Use, publish, submit, payment, or other external effect.
7. Only after all same-run evidence is present may the worker route be
   switched from local stdio to the remote server. Until then, local stdio is
   retained and a remote blocker fails closed.

Mac-worker capabilities remain intentionally local: canonical Browser Use CLI
sessions, iPhone/Simulator control, Obsidian vault access, and local files.
Moving the Codex App Server to Zeabur does not move those capabilities or
authorize public access to them. If the Mac is closed, AOS scheduler/queue and
Zeabur Codex inference may continue, but Browser Use jobs remain queued until
the Mac worker reconnects; no alternate PC or Zeabur browser fallback is
allowed.

The official App Server WebSocket transport is currently documented as
experimental and unsupported for production workloads. Treat that as a hard
promotion blocker even when the technical canary passes:
<https://learn.chatgpt.com/docs/app-server.md>
