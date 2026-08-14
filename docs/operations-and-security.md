# Operations and security

## Settings categories

Administrator Settings are grouped into:

- **Delivery** — releases, previews, deployment behavior.
- **Configuration** — environment variables and database profiles.
- **Automation** — jobs and runtime-log workflows.
- **Instance** — Git providers, backups, observability/export settings.
- **Administration** — accounts, OIDC, Cloudflare, Certbot, registration, and persistent instance policy.

## Environment variables and secrets

Environment variables are stored per site. Secret values are encrypted at rest and are not returned in ordinary API payloads.

Use the environment-variable copy control to copy selected variables between sites. The dashboard keeps the selector and action button responsive on narrow layouts.

Build-time and runtime subprocesses receive purpose-specific environment allowlists. SHAM's own JWT/master-key secrets are not intentionally forwarded into hosted applications.

For containers, secret values are supplied through controlled environment-file/inherited-environment mechanisms rather than being embedded directly into a visible Docker command line.

## Backups

Backups use a consistent SQLite snapshot and support configured local/off-host destinations.

## Restore safety

Restore is intentionally staged:

1. Verify the archive exists and is an expected backup.
2. Stream-inspect the complete tar listing.
3. Reject traversal, absolute paths, links, special files, oversized entry names, and excessive entry counts before extraction.
4. Extract into an isolated staging directory.
5. Validate the extracted tree.
6. Open the staged SQLite database read-only.
7. Run `quick_check`.
8. Verify core SHAM tables.
9. Atomically swap the data directory.
10. Preserve backup/update stores and roll back the directory swap on failure.

A malformed backup should never require deleting the live instance first.

## Monitoring and performance

The **Performance** navigation item exposes live and historical metrics including CPU, memory, request/error rate, latency, connections, restart activity, and persisted p50/p95 history.

Per-site alert rules can define thresholds. Active alerts are surfaced in both Performance and the Dashboard quick views.

Health-check loops, performance sampling, Cloudflare Tunnel lifecycle work, and runtime shutdown are concurrency-bounded to avoid synchronized bursts on larger hosts.

## Cloudflare

SHAM can manage:

- DNS records.
- WAF/firewall synchronization.
- Per-site Cloudflare Tunnels.
- Periodic reconciliation of opted-in records/rules.

Cloudflare credentials are encrypted. Treat the token as infrastructure administration access and scope it to the smallest required zone/account permissions.

## Certbot

Certificate issuance/renewal coordinates with SHAM's shared port-80 edge listener. Review warnings about nonstandard public ports and ensure the hostname resolves correctly before issuance.

## OIDC

OIDC uses Authorization Code flow with PKCE, state, nonce, JWKS signature verification, issuer/audience checks, time validation, and optional controlled user auto-provisioning.

The client secret is encrypted at rest. Keep the issuer URL HTTPS and restrict auto-provisioned roles.

## Local authentication

SHAM supports password login, TOTP, recovery codes, and WebAuthn passkeys. Administrators can manage registration policy and users from Settings → Administration.

## API tokens

API tokens are independently revocable and scoped. Prefer them over password/session reuse for CI/CD and scripts.

## Docker trust boundary

Access to the Docker daemon is effectively host-administration access. SHAM validates hosted Compose projects to block common escape paths, but you should still:

- Keep SHAM itself minimally privileged.
- Protect the Docker socket.
- Review Dockerfiles/Compose files.
- Avoid exposing unrelated host paths.
- Separate hostile tenants at a stronger infrastructure boundary than a single Docker daemon.

## Plugin trust boundary

JavaScript plugins are trusted server-side code. Worker isolation improves fault containment but is not an operating-system sandbox. Only install reviewed plugins.

The plugin playground does **not** execute server plugin code; its browser preview is a sandboxed development convenience.

## Release hygiene

Run:

```bash
npm run release:check
```

before packaging. It performs recursive syntax checks, the test suite, and source-tree release checks including generated-secret detection.

Never ship `.env`, `node_modules`, Git credentials, `data/.jwt-secret`, the live SQLite database, runtime directories, or backup payloads in a source release.
