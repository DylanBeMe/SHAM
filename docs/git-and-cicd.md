# Git and CI/CD

SHAM can deploy from a direct Git URL or use encrypted provider connections for repository discovery and private HTTPS credentials.

## Supported provider connections

| Provider | Hosted/self-hosted | Repository discovery | Private HTTPS credentials | Configurable base URL |
|---|---|---:|---:|---:|
| GitHub | Hosted | Yes | Yes | No |
| GitLab | Hosted in current provider UI | Yes | Yes | No |
| Bitbucket Cloud | Hosted | Yes | Yes | No |
| Gitea | Hosted/self-hosted | Yes | Yes | Yes |
| Forgejo | Hosted/self-hosted | Yes | Yes | Yes |

Direct HTTPS/SSH repository URLs remain available independently of provider discovery.

Gitea/Forgejo base URLs must be valid HTTP/HTTPS origins/paths without embedded credentials, query strings, or fragments. SHAM refuses ambiguous provider matching rather than silently injecting credentials from the wrong connection.

## Connect a provider

Open **Settings → Instance → Git provider connections**.

For Gitea/Forgejo, configure the instance base URL, for example:

```text
https://git.example.com
```

Provider tokens are encrypted at rest. Give the token only the repository/API permissions needed for discovery, clone, and optional webhook management.

## Private repositories

### Connected HTTPS provider

SHAM injects provider credentials into the Git subprocess environment/credential flow. It does not persist repository URLs containing credentials.

Repository URLs containing embedded credentials or query parameters are rejected; use a provider connection or deploy key instead.

### SSH deploy key

For direct SSH repositories, supply a dedicated repository-scoped deploy key.

Do not reuse an administrator's broad personal SSH key.

## Git deployment lifecycle

A Git deployment generally does the following:

1. Create a deployment record/log context.
2. Clone the requested branch shallowly into staging.
3. Read any `sham.yaml`, `sham.yml`, or `sham.json`.
4. Compare execution-policy hash with the approved policy.
5. Run install/build commands where allowed by the runtime type.
6. Put the candidate at its immutable final release path.
7. Start the candidate with the same runtime engine used by normal production starts/previews.
8. Wait for readiness.
9. Switch traffic to the candidate.
10. Drain/stop the previous backend.
11. Persist active release/deployment metadata.
12. Retain previous releases according to retention settings.

If candidate startup/readiness fails, the old backend stays active. Promotion bookkeeping failure is handled transactionally so SHAM does not intentionally leave traffic pointing at an untracked candidate.

## Repository manifests and approval

Example:

```yaml
build:
  command: npm ci && npm run build

runtime:
  driver: process
  command: ["npm", "run", "start"]
  portEnv: PORT

health:
  type: http
  path: /health
  startupTimeout: 45
```

Execution-policy changes require explicit approval. This includes changes that alter runtime command, build steps, container/Compose behavior, readiness, or shutdown policy covered by the manifest hash.

Do **not** automatically pass `--approve-manifest` for unreviewed pull-request code.

## Build behavior by runtime

- **Static/process** sites can use SHAM install/build commands, then execute/serve the resulting release.
- **Container source builds** use Dockerfile/Buildpack/Nixpacks image construction as the source-managed build boundary.
- **Compose** builds should be expressed in the Compose services/Dockerfiles rather than duplicated as SHAM host build commands.

## Push webhooks

Endpoint:

```text
POST /api/hooks/deploy/:siteId
```

SHAM normalizes provider-specific event/delivery headers and verifies the configured provider/HMAC authentication. Delivery identifiers are stored for replay protection for a bounded period (14 days in the current implementation).

Signature/token inputs recognized by the current webhook layer include GitHub-style `X-Hub-Signature-256`/`X-Hub-Signature`, Gitea/Forgejo signature headers, SHAM's `X-SHAM-Signature`, and GitLab's `X-Gitlab-Token` token flow. Bitbucket push events are normalized from their provider payload/event headers.

GitHub, GitLab, Bitbucket Cloud, Gitea, Forgejo, and SHAM-style delivery identifiers/payload handling are recognized by the webhook layer.

A valid webhook for a branch other than the configured branch is acknowledged but does not deploy that site.

## Webhook public URL

Configure the externally reachable SHAM webhook base URL before asking SHAM to create/reconcile provider webhooks.

Use HTTPS. Treat the endpoint as internet-facing even when signatures/tokens are required.

## Previews

Preview deployments use the same runtime specification/lifecycle as production instead of a separate Node-only path.

Previews receive temporary hostnames and expire according to their TTL. Delete them early when they are no longer needed to conserve runtime/storage resources.

## Releases and rollback

Releases remain at stable immutable paths. Rollback starts the retained release, waits for readiness, switches traffic, and drains the backend being replaced.

Rollback is a runtime/release operation; it does not rewrite Git history.

## CI/CD with API tokens

Create an API token under **Security → API Tokens**. A typical deployment token needs `deploy`; runtime-control automation needs `sites:control`. Add `logs:read` only when the pipeline reads runtime logs.

Example:

```bash
export SHAM_URL="https://sham.example.com"
export SHAM_TOKEN="sham_pat_..."

sham deploy 12 --branch main
```

If the reviewed commit intentionally changes execution policy:

```bash
sham deploy 12 --branch main --approve-manifest
```

Store `SHAM_TOKEN` in the CI provider's secret store. Do not echo it.

## CLI operation timeouts

The bundled CLI uses short bounded timeouts for ordinary/control calls, but deploy and rollback commands receive longer bounds because those server endpoints can wait for build/readiness work.

Current defaults:

- Ordinary/control calls: 30 seconds.
- Deploy: up to 30 minutes client-side.
- Rollback: up to 10 minutes client-side.

Your reverse proxy may also have a request timeout; align it with the deployment workflow.

## Troubleshooting

If repository discovery fails:

- Verify token permissions.
- Verify Gitea/Forgejo base URL.
- Confirm the repository URL actually belongs to that provider connection.
- Check for ambiguous self-hosted provider configuration.

If a webhook does not deploy:

- Confirm public webhook base URL and HTTPS reachability.
- Verify signature/token configuration.
- Confirm configured branch.
- Confirm provider delivery identifier/event type.
- Check deployment logs for manifest approval/build/runtime failures.

See [Troubleshooting](troubleshooting.md) for more cases.
