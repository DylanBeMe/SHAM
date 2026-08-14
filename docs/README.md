# SHAM documentation

SHAM is a self-hosted deployment and operations control plane. Start here, then use the focused guides below instead of treating the root README as the entire manual.

## Guides

- [Getting started](getting-started.md) — installation, first login, creating a site, storage, updates, and common deployment flow.
- [Runtimes and Docker](runtimes-and-docker.md) — static/process/container/Compose/proxy drivers, Docker images, Dockerfiles, Buildpacks, Nixpacks, health probes, ports, and `sham.yaml`.
- [Git and CI/CD](git-and-cicd.md) — GitHub, GitLab, Bitbucket Cloud, Gitea, Forgejo, webhooks, private repositories, releases, previews, and manifest approvals.
- [API and CLI](api-and-cli.md) — authentication, API-token scopes, stable automation endpoints, examples, CLI usage, errors, and limits.
- [Operations and security](operations-and-security.md) — environment variables, secrets, backups/restores, jobs, monitoring, alerts, Cloudflare, Certbot, OIDC, and trust boundaries.
- [Plugin development](plugin-development.md) — plugin manifests, permissions, client/server behavior, installation, worker isolation, and the built-in plugin playground.
- [Troubleshooting](troubleshooting.md) — upload errors, readiness failures, Docker/Compose diagnostics, Git webhooks, restore failures, and release checks.

## Documentation in the dashboard

The **Documentation** view mirrors these categories for quick operational reference. Use `Ctrl/Cmd+K` to search the command palette for documentation, settings, sites, performance, logs, and common site actions.

## Versioning

The HTTP API currently lives under `/api`. SHAM does not yet expose a separate `/api/v1` namespace, so automation should prefer the documented endpoints in [API and CLI](api-and-cli.md) and avoid relying on undocumented response fields.
