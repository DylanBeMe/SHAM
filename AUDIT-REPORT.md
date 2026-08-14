# SHAM 1.0.0 Code, Reliability, Performance, and UI Audit

**Audit date:** 2026-08-13
**Scope:** First-party server, browser, runtime, deployment, database, backup/restore, Git-provider, container/Compose, authentication, plugin, tests, documentation, and release-packaging source in the supplied archive.

## Result

The audited tree passes:

- `npm run check`: **66 JavaScript files syntax-valid**.
- `npm test`: **229/229 tests passing**.
- `npm run release:check`: passing, including release metadata/source-tree checks.
- `git diff --check`: no whitespace errors.
- Static dashboard structure: **568 unique IDs, no duplicate IDs, and no dangling label targets**.
- The full test run does **not** generate `data/.jwt-secret`.

The available execution environment does not permit Docker CLI/daemon execution, so Dockerfile/Compose changes were audited and regression-tested at the runtime-spec, validation, lifecycle, cleanup, networking, and source-policy levels rather than by launching live containers. A Chromium UI smoke process was also unavailable in this sandbox, so UI verification used source/DOM/CSS consistency checks and regression tests.

## Reliability and regression fixes

- Runtime promotion is transactional: persistence/protection failures restore the previous backend or tear down a first-start gateway instead of leaving split-brain state.
- Candidate rollback handles the no-previous-backend case and removes a promoted candidate when later release metadata fails.
- Docker startup removes partially created containers when port discovery/readiness/backend construction fails.
- Compose startup tears down partial projects on failure.
- SHAM-built transient runtime images are removed during cleanup.
- Scheduled/manual jobs target the actual active container/Compose backend rather than stale fixed container names.
- Release activation keeps running applications on immutable paths; active processes are not renamed underneath.
- Backup restore validates the complete archive stream before extraction, rejects traversal/links/special files, stages extraction, runs SQLite `quick_check`, verifies core tables, and atomically swaps with rollback.
- Runtime, health, tunnel, and shutdown work use bounded concurrency where bulk fan-out would otherwise create bursts.
- Stream logging preserves chunk-split lines and bounds long newline-free records.
- Folder upload multipart field headroom was raised to a bounded dedicated limit so the expanded site form no longer triggers `Too many fields`.
- Explicit idempotent `/start` and `/stop` API routes now match the bundled CLI.
- CLI requests use bounded operation-aware timeouts rather than either hanging forever or aborting long deploys after 30 seconds.
- Tests provide a dedicated JWT secret so CI cannot regenerate source-tree instance credentials.

## Docker, Dockerfile, and Compose

- Existing OCI images are first-class site sources and are not overwritten by an empty source mount.
- Dockerfile build context/path resolution is constrained inside the deployed release.
- Compose project normalization rejects truncated/oversized structural output.
- Auxiliary Compose services cannot publish host ports.
- Selected service publication is loopback-only when host-published.
- Containerized SHAM connects to selected Compose services over the managed Docker network instead of treating container-local `127.0.0.1` as the host.
- No-egress Compose deployments receive internal-network overrides.
- Hosted Compose rejects privileged mode, host network/PID/IPC, added capabilities, devices, Docker socket mounts, host bind mounts, host-gateway mappings, disabled security profiles, privileged build entitlements, and unmanaged external networks/volumes/configs/secrets.
- Docker-isolated Node dependencies are installed in a runtime-compatible container environment.
- Secret values are not embedded directly into Docker CLI `KEY=value` arguments.

## Git and CI/CD

- Provider connections support GitHub, GitLab, Bitbucket Cloud, Gitea, and Forgejo.
- Gitea/Forgejo support configurable self-hosted base URLs.
- Repository-provider matching prefers the most-specific path and refuses ambiguous matches instead of injecting the wrong credentials.
- Connected providers with identical effective self-hosted base URLs are rejected.
- Provider webhook parsing supports provider-specific delivery IDs/push payloads while retaining persistent replay protection.
- `sham.yaml`/`sham.yml`/`sham.json` execution-policy changes require explicit approval.
- Preview and production deployments share the same runtime lifecycle.

## UI consistency

- The four Dashboard attention cards are clickable drilldowns for health, failed deployments, active alerts, and automated traffic.
- Performance is available directly from the left navigation.
- Recovery readiness/API Tokens use a spaced responsive grid.
- Environment-variable copy controls and variable rows use responsive layouts that prevent button/input collisions.
- Git-provider connection rows wrap/collapse consistently at smaller widths.
- Administration is a dedicated Settings category for accounts, Cloudflare, Certbot, OIDC/identity, users, and persistent policy.
- Appearance separates System/Light/Dark mode from Purple/Midnight/Emerald/Custom palettes.
- Invalid stored custom themes fail closed to a safe preset.
- Logout uses a normal labeled sidebar control rather than a mismatched circular icon treatment.
- Command palette searches settings categories, sites, site files/logs/settings/actions, performance metrics, and documentation.
- `/LICENSE` is explicitly served and reports a useful error if the file is absent.
- Tooltips use a floating top-layer implementation and toast regions attach to the active dialog/popover when necessary.
- Modal overflow/stacking was adjusted so notifications are not clipped behind blur/top-layer content.
- Source/runtime UI avoids duplicate generic/legacy container-image controls.

## API and plugin development

- Categorized documentation now covers getting started, runtimes/Docker, Git/CI/CD, API/CLI, operations/security, plugin development, and troubleshooting.
- API docs describe bearer tokens/scopes, stable runtime/deployment/log/performance endpoints, errors, limits, and CLI commands.
- Plugin playground validates manifests with SHAM's production validator and previews browser plugin UI in a sandboxed, network-blocked iframe.
- Playground payload size is bounded for both string and object manifest input.
- Server plugin code is intentionally never executed by the playground.

## Remaining validation boundary

No source-level audit can prove the safety of arbitrary user Dockerfiles/Compose applications, third-party plugins, provider infrastructure, certificates/DNS, or host Docker configuration. Before production rollout, run the included release checks plus live integration tests on a staging host with the same Docker daemon, reverse proxy, Git providers, and storage configuration as production.
