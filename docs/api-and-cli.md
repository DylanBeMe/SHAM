# API and CLI

SHAM's browser UI uses the same HTTP API that is available for automation. The current API prefix is `/api`.

## Authentication

### Browser sessions

Interactive login uses SHAM's authenticated cookie flow and same-origin protections.

### API tokens

Create a token in **Security → API Tokens**. The plaintext token is shown once. SHAM stores only a hash.

Send it as:

```http
Authorization: Bearer sham_pat_...
Accept: application/json
```

Keep tokens out of repository files and build logs.

## Token scopes

Common scopes are:

- `read` — read general site/status data.
- `logs:read` — read runtime logs.
- `deploy` — trigger Git deployment/rollback operations covered by the deployment API.
- `sites:control` — start, stop, and restart sites.
- `*` — unrestricted API-token scope; use only for trusted administration automation.

Some administrator-only endpoints additionally require an administrator user/token context and may not be appropriate for unattended automation.

## Stable automation endpoints

### List sites

```http
GET /api/sites
```

### Start a site

```http
POST /api/sites/:id/start
```

Idempotent: an already-running backend is not restarted simply because `start` is called again.

### Stop a site

```http
POST /api/sites/:id/stop
```

Idempotent: an already-stopped site remains stopped.

### Restart a site

```http
POST /api/sites/:id/restart
```

### Deploy Git

```http
POST /api/sites/:id/deploy/git
Content-Type: application/json

{
  "branch": "main",
  "approveManifestChanges": false
}
```

A repository-controlled runtime-policy change can return HTTP `409` with code `SHAM_MANIFEST_APPROVAL_REQUIRED`.

### Roll back a retained release

```http
POST /api/sites/:id/releases/:releaseId/rollback
```

### Runtime logs

```http
GET /api/runtime-logs?siteId=12&limit=200
```

Search:

```http
GET /api/runtime-logs/search?siteId=12&q=timeout
```

### Performance

```http
GET /api/performance
GET /api/sites/:id/performance/history
GET /api/sites/:id/alert-rules
PUT /api/sites/:id/alert-rules
```

### Deployments

```http
GET /api/sites/:id/deployments
GET /api/sites/:id/deployments/:deploymentId/logs
```

## Other API groups

The dashboard also exposes authenticated endpoint groups for:

- Site files and content replacement.
- Snapshots and dependency scans.
- Environment variables and secret reveal/copy flows.
- Scheduled jobs.
- Database connection profiles.
- Preview deployments.
- Git-provider administration.
- Backups and staged restore.
- Alert destinations.
- Audit export/history.
- Cloudflare DNS/WAF/Tunnels.
- Certbot certificate operations.
- Plugins and the plugin manifest playground.
- OIDC/registration/user administration.
- API-token, TOTP, recovery-code, and passkey management.

Use browser developer tools or the source route modules when developing against an endpoint that is not yet declared stable in this guide.

## CLI

The package exposes `sham` through `bin/sham.js`.

Environment:

```bash
export SHAM_URL="https://sham.example.com"
export SHAM_TOKEN="sham_pat_..."
```

Commands:

```bash
sham sites
sham deploy <site-id> [--branch main] [--approve-manifest]
sham logs <site-id> [--limit 200]
sham start <site-id>
sham stop <site-id>
sham restart <site-id>
sham rollback <site-id> <release-id>
```

Ordinary CLI HTTP requests have a 30-second client timeout. Git deploy commands allow up to 30 minutes and rollback commands up to 10 minutes because those endpoints can wait for builds/readiness. If your reverse proxy has a shorter request timeout, align it with your deployment workflow.

## Example with curl

```bash
curl --fail-with-body   -H "Authorization: Bearer $SHAM_TOKEN"   -H "Accept: application/json"   "$SHAM_URL/api/sites"
```

```bash
curl --fail-with-body   -X POST   -H "Authorization: Bearer $SHAM_TOKEN"   -H "Accept: application/json"   "$SHAM_URL/api/sites/12/restart"
```

## Errors

JSON API errors use an `error` message. Validation failures are normally `400`; authentication failures `401`; authorization failures `403`; missing resources `404`; conflicts such as manifest approval/runtime-state transitions may use `409`; request-size limits use `413`; rate limits use `429`.

Do not parse human-readable error text when a structured `code` field is available.

## Request limits

SHAM deliberately bounds JSON bodies, multipart field counts, file counts, file sizes, archive entries, log output capture, and several list/query limits. Clients should treat `400`/`413` as configuration/input errors rather than retrying them indefinitely.

## API compatibility

There is currently no `/api/v1` versioned namespace. Pin SHAM versions for critical automation, use the documented endpoints above, and test upgrades in staging.
