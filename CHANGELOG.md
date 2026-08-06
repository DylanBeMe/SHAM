# Changelog

All notable public changes to SHAM are documented here. The project follows Semantic Versioning.

## [Unreleased]

### Added

- Supervised remotely managed Cloudflare Tunnel support with encrypted token storage, administrator controls, bounded restart backoff, and Docker packaging.

## [1.0.0] — 2026-08-05

First public stable release.

### Added

- Static-site and managed Node.js hosting from one self-hosted dashboard.
- Atomic Git deployments, signed webhooks, previews, releases, and rollback.
- File management, snapshots, dependency scanning, scheduled jobs, and external backups.
- Multi-user authentication, administrator/user roles, TOTP, recovery codes, and WebAuthn passkeys.
- Encrypted secret storage, security controls, observability, alerts, public status, and performance monitoring.
- Optional Docker-isolated site runtimes and Anubis anti-bot sidecars.
- Theme-consistent responsive dashboard, built-in documentation, and accessibility improvements.
- GitHub Actions for CI, Docker build validation, GHCR publishing, lockfile preparation, and tagged releases.

### Security

- Hardened upload archive handling and worker-safe multipart temporary storage.
- Uniform deployment-webhook authentication failures and replay protection.
- Authentication before mutation-queue admission.
- Owner-only permissions for sensitive local files where supported.
- Redirect rejection for credential-bearing outbound integrations.
- Minimal unauthenticated health and optional public-status responses.

### Notes

Earlier version labels were internal development identifiers. Version 1.0.0 starts the public release history.
