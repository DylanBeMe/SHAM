# Git and CI/CD

## Supported provider connections

SHAM can store encrypted provider credentials for:

- GitHub
- GitLab
- Bitbucket Cloud
- Gitea
- Forgejo

Gitea and Forgejo accept a configurable base URL for self-hosted instances. Do not configure multiple connected self-hosted providers with the same effective base URL because repository ownership would be ambiguous; SHAM rejects that configuration.

You can also deploy a repository URL directly with an SSH deploy key without using a provider connection.

## What provider connections do

A connection can provide:

- Repository discovery in the site wizard/settings.
- Credentials for private HTTPS cloning.
- Commit links.
- Provider webhook creation where supported by the provider API.

Provider tokens are encrypted at rest.

## Git deployment

A site records its repository URL and branch. Deployment clones a shallow single branch into staging, records commit metadata, removes `.git` from the release, evaluates the runtime manifest, runs configured build steps, starts a candidate, waits for readiness, and activates the immutable release.

## Private repositories

For provider-managed HTTPS repositories, SHAM injects credentials into the Git subprocess environment rather than rewriting saved repository URLs with embedded secrets.

For an SSH URL, supply a dedicated deploy key with repository-only access.

## Webhooks

The deploy webhook endpoint is:

```text
POST /api/hooks/deploy/:siteId
```

Provider-specific signature/event headers are normalized by SHAM. Replay protection stores a bounded delivery identifier for 14 days. GitHub, GitLab, Bitbucket, Gitea, Forgejo, and SHAM delivery headers are recognized.

Webhook requests for a different configured branch are acknowledged and ignored.

Configure the public webhook base URL in administrator settings before asking SHAM to create provider webhooks.

## Bitbucket Cloud

Use a repository access token appropriate for repository read/webhook access. SHAM uses Bearer authentication for the Bitbucket API and `x-token-auth` for Git HTTPS credential injection.

## Gitea and Forgejo

Set the provider base URL to the root URL of your instance, for example:

```text
https://git.example.com
```

SHAM derives provider API and repository matching behavior from that base.

## CI/CD with API tokens

Create an API token in **Security → API Tokens** and give CI only the scopes it needs. A deployment job typically needs `deploy`; runtime-control jobs need `sites:control`.

Example:

```bash
export SHAM_URL="https://sham.example.com"
export SHAM_TOKEN="sham_pat_..."
sham deploy 12 --branch main
```

If a repository manifest changes execution policy, review the change and intentionally re-run with:

```bash
sham deploy 12 --branch main --approve-manifest
```

Do not automatically approve arbitrary manifest changes from untrusted pull requests.

## Previews and releases

Preview deployments use the same runtime specification/lifecycle as production. Releases are retained at immutable paths so running applications do not have their working directory renamed beneath them.

Rollback starts the retained release, verifies readiness, switches traffic, and then drains the previous backend.

## Troubleshooting webhooks

Check:

1. The webhook base URL is externally reachable over HTTPS.
2. The provider connection still has sufficient permissions.
3. The webhook is targeting the configured branch.
4. Delivery identifiers are present.
5. Runtime/deployment logs show the build failure rather than only the provider's HTTP status.
6. A manifest approval error (`SHAM_MANIFEST_APPROVAL_REQUIRED`) is not blocking execution-policy changes.
