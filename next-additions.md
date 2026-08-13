# Next Additions

This document tracks high-value additions that could make SHAM feel more like a complete self-hosted deployment platform and control plane.

## Suggested next release

A strong next release could focus on finishing the remaining provider automation and deepening the features that are now present:

- [x] Git provider connection, repository selection, and private HTTPS clone authentication
- [x] First-class deployment history and site workspace actions
- [ ] Automatic Cloudflare setup and routing
- [x] Redesigned site overview and dashboard experience

These features reinforce each other and would make deploying, operating, and troubleshooting sites significantly smoother.

## 1. Git provider integration

- [x] Add GitHub integration.
- [x] Add GitLab integration.
- [x] Allow users to connect and disconnect provider accounts from the UI.
- [x] Let users select a repository and branch when creating a site.
- [x] Add automatic deploy-on-push without requiring manual webhook setup when a public SHAM URL is configured.
- [x] Show the deployed commit SHA, author, commit message, and deployment duration.
- [ ] Link deployments back to the corresponding commit or diff in the Git provider.
- [x] Add a **Redeploy this commit** action.
- [x] Surface provider connection and webhook errors clearly in the UI.

## 2. First-class deployment history

- [x] Add a deployment timeline for each site.
- [ ] Track deployment states such as queued, building, running, failed, rolled back, and superseded.
- [ ] Attach build and runtime logs to each deployment.
- [x] Show commit metadata alongside each deployment when Git integration is configured.
- [x] Add one-click redeploy for a previous release.
- [x] Add one-click rollback to a previous successful release.
- [x] Show deployment duration and failure reason at a glance.
- [ ] Make the currently active release easy to identify.

## 3. Environment variables and secrets UX

- [x] Replace basic environment editing with a table-style variable editor.
- [x] Mask secret values by default.
- [ ] Allow users to reveal or replace individual secrets with appropriate permissions.
- [x] Support bulk paste/import from `.env` format.
- [x] Add copy actions for moving variables between sites/environments without exposing secret values to the browser.
- [x] Show which variable names changed without exposing their values.
- [x] Warn users when changes require a restart or redeploy.
- [x] Add validation for malformed variable names and duplicate keys.

## 4. Automatic Cloudflare setup

Build on the per-site Cloudflare Tunnel support so SHAM can configure the Cloudflare side of a site's networking automatically.

- [ ] Allow an administrator to configure a Cloudflare API token with the minimum required permissions.
- [ ] Create Cloudflare Tunnels directly from SHAM.
- [ ] Create and update DNS records for site domains automatically.
- [ ] Configure public hostname routes from a domain to the correct SHAM site.
- [ ] Detect mismatched or stale DNS and tunnel routes.
- [ ] Offer a repair/reconcile action for incorrect Cloudflare configuration.
- [ ] Support recreating stale or broken connectors safely.
- [ ] Allow managed Cloudflare resources to be removed when a site is deleted, with an explicit confirmation step.
- [ ] Add a simple **Expose through Cloudflare** workflow that lets users choose a domain and save.
- [ ] Clearly distinguish SHAM-managed Cloudflare resources from externally managed resources.

## 5. Site health dashboard

- [ ] Add CPU usage metrics per site.
- [ ] Add memory usage metrics per site.
- [ ] Show requests per minute.
- [ ] Show p50 and p95 response times.
- [ ] Show HTTP error rate.
- [ ] Track site uptime and recent downtime.
- [ ] Show current or recent connection counts where available.
- [ ] Track process/container restarts.
- [ ] Add compact time-series charts to the site overview.
- [ ] Add configurable time ranges such as 1 hour, 24 hours, 7 days, and 30 days.

## 6. Notifications and alerting

- [ ] Add a user-facing alert rules UI.
- [ ] Notify when a site becomes unavailable.
- [ ] Notify when a site enters a crash loop or repeatedly restarts.
- [ ] Notify when a deployment fails.
- [ ] Notify before a TLS certificate expires.
- [ ] Notify when a backup fails.
- [ ] Notify when a Cloudflare Tunnel disconnects or becomes unhealthy.
- [ ] Notify when dependency or security scanning finds a significant issue.
- [ ] Add Discord notifications.
- [ ] Add Slack notifications.
- [ ] Add generic webhook notifications.
- [ ] Add email notifications.
- [ ] Support per-site notification preferences and severity thresholds.

## 7. OIDC / SSO

- [ ] Add generic OpenID Connect support.
- [ ] Document Authentik configuration.
- [ ] Document Authelia configuration.
- [ ] Document Keycloak configuration.
- [ ] Support Google Workspace via OIDC.
- [ ] Support Microsoft Entra ID via OIDC.
- [ ] Map identity-provider groups or claims to SHAM roles where practical.
- [ ] Keep local administrator authentication available as a recovery mechanism.
- [ ] Add clear diagnostics for invalid issuer, callback, claim, and certificate configuration.

## 8. Site templates

Add presets to make common deployments faster and reduce configuration mistakes.

- [x] Add a Static Site template.
- [x] Add a Node.js / Express template.
- [x] Add a Next.js standalone template.
- [x] Add an Astro template.
- [x] Add a Vite / React template.
- [ ] Add a Hugo template.
- [x] Add a Reverse Proxy template.
- [x] Preconfigure sensible install/build commands and output paths per template.
- [x] Allow templates to be customized before the site is created.
- [x] Keep a custom/manual option for unsupported stacks.

## 9. Reverse-proxy sites

This is a particularly high-value addition because it would let SHAM manage services that it does not launch itself, extending SHAM from a hosting panel into a broader control plane for homelab and server workloads.

Example:

```text
app.example.com -> http://192.168.1.50:3000
```

- [x] Add a site type for externally hosted upstreams.
- [x] Support HTTP and HTTPS upstream URLs.
- [x] Support LAN IP addresses and hostnames.
- [x] Add upstream connection and health checks through the normal site health path.
- [x] Allow SHAM-managed TLS and domains in front of reverse-proxy sites.
- [x] Allow Cloudflare Tunnel routing in front of reverse-proxy sites.
- [x] Reuse existing headers, security policy, metrics, and access-control features where possible.
- [ ] Support optional host-header overrides.
- [ ] Support configurable upstream timeouts.
- [x] Add clear errors for invalid upstreams and runtime health failures for unreachable upstreams.
- [x] Add maintenance-mode support for proxied services.

## 10. Dashboard redesign and command palette

- [x] Redesign the main dashboard around site health, recent deployments, and items needing attention.
- [x] Improve site cards with clearer status and primary actions.
- [x] Add global search for sites and domains through the command palette.
- [x] Add a `Ctrl/Cmd + K` command palette.
- [x] Add quick actions for deploy, restart, logs, configuration, and files.
- [ ] Allow sites to be pinned or favorited.
- [x] Improve empty states and onboarding guidance.
- [x] Add a recent activity feed to the dashboard.
- [x] Improve responsive/mobile layouts.
- [x] Continue standardizing spacing, typography, status badges, and destructive-action patterns.
