# Roadmap and next additions

This document tracks work that is **not yet fully implemented** in SHAM. It intentionally excludes features that have already landed so the roadmap does not drift behind the product.

For the current feature set, start with the [README](README.md) and [documentation index](docs/README.md).

## Recently completed platform work

The current unreleased work already includes the following major additions, so they are no longer roadmap items:

- Generic static, process, container, Docker Compose, and reverse-proxy runtime drivers.
- Process presets for Node.js, npm, Bun, Deno, FastAPI/Uvicorn, Django/Gunicorn, Go, Java JARs, and custom commands.
- Existing Docker/OCI image deployments, Dockerfile builds, Cloud Native Buildpacks, and Nixpacks.
- Candidate-first readiness checks, immutable releases, rollback, liveness checks, graceful shutdown, and runtime reconciliation.
- `sham.yaml` / `sham.yml` / `sham.json` deployment manifests with execution-policy approval.
- GitHub, GitLab, Bitbucket Cloud, Gitea, and Forgejo provider connections plus direct Git URLs.
- Deployment history, previews, webhooks, commit metadata, redeploy, and rollback.
- Generic OIDC SSO, scoped API tokens, and the bundled `sham` CLI.
- Per-site CPU, memory, request/error-rate, latency, p50/p95, connection, and restart history with alert-rule configuration.
- Dashboard attention drilldowns, Performance navigation, expanded command-palette search, responsive settings, and the appearance/theme redesign.
- Staged/validated backup restore, Cloudflare reconciliation controls, and stronger Docker/Compose isolation checks.
- Plugin permissions/signing/worker isolation plus the administrator plugin-development playground.
- Categorized repository and in-dashboard documentation, including API and configuration references.

## Highest-value remaining work

### 1. Cloudflare resource ownership and lifecycle

SHAM can already store Cloudflare settings, reconcile selected DNS/firewall state, and operate Cloudflare Tunnels. The next step is making resource ownership explicit enough for safe end-to-end automation.

- [ ] Create Cloudflare Tunnels directly from SHAM instead of requiring externally created tunnel credentials in all workflows.
- [ ] Create/update public-hostname tunnel routes from site-domain configuration.
- [ ] Track which DNS, WAF, and Tunnel resources are SHAM-managed versus externally managed.
- [ ] Detect stale/missing tunnel connectors and offer a safe repair workflow.
- [ ] Offer an **Expose through Cloudflare** flow that provisions only the resources the administrator approves.
- [ ] Remove SHAM-managed Cloudflare resources during site deletion only after explicit confirmation.
- [ ] Add drift history so administrators can see what reconciliation changed and why.

### 2. Alerting and notification policy

SHAM already has per-site alert rules and Discord, Slack, generic webhook, and email destinations. The remaining work is richer policy/routing and coverage.

- [ ] Add per-site destination selection instead of relying primarily on instance-wide destinations.
- [ ] Add severity and quiet-hours policies.
- [ ] Add dedicated alerts for deployment failure, crash loops, and repeated restarts.
- [ ] Add TLS-expiry alerts.
- [ ] Add backup-failure and stale-backup alerts.
- [ ] Add Cloudflare Tunnel health/disconnect alerts.
- [ ] Add dependency/security-scan severity alerts.
- [ ] Add notification deduplication, recovery notifications, and configurable reminder intervals.

### 3. OIDC provider recipes and role mapping

Generic OIDC Authorization Code + PKCE support is implemented. What remains is reducing provider-specific setup friction and improving authorization mapping.

- [ ] Add tested Authentik configuration examples.
- [ ] Add tested Authelia configuration examples.
- [ ] Add tested Keycloak configuration examples.
- [ ] Add Google Workspace configuration guidance.
- [ ] Add Microsoft Entra ID configuration guidance.
- [ ] Map configured identity-provider groups/claims to SHAM roles where practical.
- [ ] Add richer diagnostics for issuer, callback, JWKS, audience, nonce, and claim failures.
- [ ] Add an administrator-visible OIDC connection test that does not require enabling SSO first.

### 4. Performance history and observability UX

The core metrics and persisted history are present. The next improvements should focus on analysis rather than collecting more counters by default.

- [ ] Add selectable 1-hour, 24-hour, 7-day, and 30-day chart ranges.
- [ ] Add downsampling/retention controls for longer metric history.
- [ ] Add deployment/restart annotations to performance charts.
- [ ] Add comparative views for current release versus previous release.
- [ ] Add site-level uptime/SLO summaries and error-budget reporting.
- [ ] Make Prometheus/OpenTelemetry export configuration visible and testable from the dashboard.

### 5. Git and source-provider depth

Five provider families are supported today. Remaining work should improve self-hosted/enterprise use and repository lifecycle handling rather than add provider-specific runtime branches.

- [ ] Support configurable self-hosted GitLab base URLs.
- [ ] Evaluate GitHub Enterprise Server connection support.
- [ ] Add provider connection-health tests and clearer token-scope diagnostics.
- [ ] Add repository pagination/search for accounts with very large repository inventories.
- [ ] Add optional pull-request/merge-request preview policies.
- [ ] Add branch/tag deployment policies and protected-production branch rules.
- [ ] Expose webhook delivery history and last provider error in the site workspace.

### 6. Docker registry and multi-service ergonomics

Docker image, Dockerfile, Buildpacks, Nixpacks, and constrained Compose deployments are implemented. The next Docker work should improve private registries and multi-service operations.

- [ ] Add encrypted private-registry credentials with per-site/repository selection.
- [ ] Add explicit image pull policies and a **Pull latest and redeploy** workflow.
- [ ] Show image digest and build provenance in deployment history.
- [ ] Add image cleanup/retention controls for SHAM-built images.
- [ ] Add per-service Compose status and logs in the site workspace.
- [ ] Add per-service Compose health summaries while keeping only the selected application service publicly routed.
- [ ] Add a Compose configuration preview that explains rejected security-sensitive fields before deployment.

### 7. API maturity

The current API and scoped-token model are documented and usable for automation. The next step is making it easier to integrate safely across releases.

- [ ] Introduce an explicitly versioned API namespace such as `/api/v1` while retaining a compatibility window for existing `/api` clients.
- [ ] Publish an OpenAPI document generated or validated against the server routes.
- [ ] Add machine-readable API error codes in addition to human-readable messages.
- [ ] Add asynchronous deployment-operation resources for callers that do not want to hold a long HTTP request open.
- [ ] Add deployment completion/failure webhooks for CI orchestration.
- [ ] Expand API-token scope granularity where current scopes are broader than necessary.
- [ ] Add token last-used IP/user-agent metadata and optional token expiry.

### 8. Plugin SDK and playground depth

The built-in playground validates manifests and safely previews browser-side plugin code. It should become a more complete development harness without turning production SHAM into an unrestricted code sandbox.

- [ ] Publish a versioned browser-plugin API reference with typed examples.
- [ ] Add a plugin scaffold/generator command.
- [ ] Add mock site/runtime/settings data to the playground for repeatable UI testing.
- [ ] Add a permission simulator that shows which APIs/actions a manifest would receive.
- [ ] Add manifest migration/version compatibility diagnostics.
- [ ] Add a local packaging/signing workflow to the CLI.
- [ ] Add plugin-specific logs and health information in the Extensions workspace.

### 9. Backup and recovery maturity

Restore now verifies archives, stages extraction, checks SQLite integrity, and atomically swaps data with rollback. Remaining work is mostly operational assurance.

- [ ] Add scheduled restore drills into an isolated temporary data directory.
- [ ] Record backup verification/restore-test history.
- [ ] Add optional client-side or repository-managed backup encryption workflows where appropriate.
- [ ] Add retention previews before destructive cleanup.
- [ ] Add destination-specific health checks for S3, SFTP, and restic targets.
- [ ] Add a guided disaster-recovery document/export containing only non-secret instance configuration and recovery instructions.

### 10. Administration and fleet ergonomics

- [ ] Add administrator-configurable maintenance windows for disruptive host-level operations.
- [ ] Add bulk site actions with explicit confirmation and bounded concurrency.
- [ ] Add import/export of non-secret site configuration.
- [ ] Add stronger account/session management, including administrator session revocation.
- [ ] Add a system-health page for disk space, database health, Docker availability, external binary versions, certificate state, and backup freshness.

## Scope boundaries

SHAM is intentionally a focused self-hosted deployment/control-plane application. Unless that direction changes, the following should remain outside the core product or require a separate design effort:

- A full browser IDE/code editor.
- General Kubernetes cluster management.
- Arbitrary privileged Compose workloads as ordinary site deployments.
- Treating the plugin playground as a safe sandbox for untrusted server-side code.
- Replacing dedicated identity providers, secret managers, registries, or observability stacks with incomplete built-in equivalents.

When adding new features, prefer extending the existing runtime/provider/plugin interfaces over introducing another one-off execution path.
