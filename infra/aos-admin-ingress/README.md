# AOS admin ingress

This service is the only public admin entrypoint for the protected Automation
OS dashboard. It performs OIDC authorization, keeps its own HttpOnly session,
and forwards authenticated traffic to the private AOS service.

## Security contract

- `OIDC_ALLOWED_EMAILS` is an explicit exact-email allowlist; wildcard domains
  are not accepted.
- The proxy strips inbound `Authorization`, cookies other than the AOS session,
  and `X-Automation-OS-Private-Ingress` before proxying.
- Only the proxy adds `X-Automation-OS-Private-Ingress`.
- `PROXY_SESSION_SECRET`, `OIDC_CLIENT_SECRET`, and
  `AOS_PRIVATE_INGRESS_SECRET` must come from a secret-safe platform path.
- Secret values must not appear in CLI arguments, build context, logs, or
  ordinary readback.
- The upstream AOS service remains on Zeabur private networking.

## Required Zeabur configuration

Create a dedicated service named `aos-admin-ingress` from this directory. Add a
Gateway route to port `8080` on that service, then set `PUBLIC_BASE_URL` to the
resulting HTTPS URL. The OIDC provider callback must be exactly:

`<PUBLIC_BASE_URL>/auth/callback`

The existing AOS service must keep the same `AOS_PRIVATE_INGRESS_SECRET` value
as this proxy. Rotate that value deliberately through a secret-safe editor if
the existing value cannot be shared by reference; never read it back.

## Readback gates

Before cutover, verify only metadata and redacted behavior:

1. `/readyz` returns `status=ready`.
2. Unauthenticated `/api/*` returns `owner_sso_required`.
3. OIDC callback accepts only an allowlisted, verified email.
4. Authenticated upstream requests contain the private-ingress header, while
   inbound spoofed headers and proxy cookies are absent.
5. AOS `/api/auth/session` returns a server-issued HttpOnly Secure cookie.
6. The Profile 2 Admin screen shows Owner diagnostics.

Do not switch the public domain or remove the existing AOS domain until all
same-run readbacks pass.
