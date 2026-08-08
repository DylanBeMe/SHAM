<p align="center">
  <img src="public/logo.svg" width="96" height="96" alt="SHAM logo">
</p>

<h1 align="center">SHAM — Simple Hosting And More</h1>

<p align="center"><strong>A self-hosted control plane for static sites and managed Node.js apps.</strong></p>
<p align="center"><strong>Current release: 1.0.0</strong> · <strong>License: AGPL-3.0-or-later</strong></p>

SHAM keeps deployments, runtime controls, security, delivery, observability, and integrations in one browser dashboard while keeping application data on infrastructure you control.

It supports:

- Static HTML, CSS, JavaScript, and asset hosting.
- Optional on-the-fly minification for HTML, CSS, JavaScript, and ES modules.
- Optional compatibility-oriented JavaScript obfuscation with explicit risk acknowledgement, bounded static analysis, preserved public names, and automatic fallback when a transform fails.
- Managed Node.js applications launched as `node server.js` or another configured entry file.
- Automatic or manual `npm install --omit=dev`.
- Per-site ports, bind addresses, custom headers, caching, SPA fallback, and domain-only access.
- Per-site local firewall controls and optional Cloudflare WAF custom-rule synchronization.
- File browsing, text-document editing, single-file replacement, and single-file deletion.
- Persistent request, bandwidth, error, response-time, visitor-IP, and country statistics with an Equal Earth country choropleth map.
- Certbot certificate issuance and renewal.
- Cloudflare DNS/WAF integration plus independently configurable, supervised Cloudflare Tunnel connectors per site for outbound-only ingress.
- Installable JSON and JavaScript plugins with settings and dashboard UI extensions.
- Multi-user authentication with administrator and user roles, TOTP, recovery codes, and WebAuthn passkeys.
- AES-256-GCM encryption for saved integration, plugin, and TOTP secrets, with administrator-triggered key rotation.
- Signed plugin verification, explicit permissions, action timeouts, bounded pending work, and optional worker isolation.
- Dependency vulnerability scanning, site snapshots, automatic rollback points, and retention limits.
- Brotli/Gzip response compression, precompressed static assets, health checks, restart policies, crash-loop protection, memory limits, and connection limits.
- A shared domain-routed edge proxy for ports 80/443, plus security-header and CSP presets.
- Structured runtime logs, privacy-aware visitor retention, configurable alerts, anomaly detection, and a live performance monitor.
- Purple-first preset themes plus a local custom-theme editor.
- Docker deployment with a configurable persistent storage path.
- Optional per-site Docker isolation, atomic release deployment and rollback, Git/webhook delivery, preview hostnames, encrypted environment variables and database profiles, scheduled jobs, off-host backups, Anubis anti-bot sidecars, observability exports, public status, localization, and signed SHAM updates.

## Important trust boundary

SHAM can execute uploaded Node.js applications and enabled JavaScript plugins. Both are trusted server-side code and can access resources available to the SHAM process. Run SHAM as an unprivileged account, isolate it from sensitive host data, review code before enabling it, and use container or operating-system controls appropriate to your threat model.

## Quick start

Requirements:

- Node.js 22 or newer.
- npm.
- A build environment supported by `better-sqlite3` when a prebuilt binary is unavailable.
- Certbot only when using the built-in SSL features outside the supplied Docker image.

```bash
cp .env.example .env
npm install
npm start
```

Open `http://127.0.0.1:8080`.

The first account becomes the administrator. Public registration is then locked automatically.

## Docker

Build and run directly:

```bash
docker build -t sham .

docker run -d \
  --name sham \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 80:80 \
  -p 443:443 \
  -p 4100-4199:4100-4199 \
  -v "$PWD/sham-data:/data" \
  -e SHAM_HOST=0.0.0.0 \
  -e SHAM_DATA_PATH=/data \
  sham
```

Or use Compose:

```bash
docker compose up -d --build
```

The Docker image includes Certbot, the Cloudflare DNS Certbot plugin, and the pinned multi-architecture `cloudflared` 2026.7.3 connector. It grants only the Node and Python executables the low-port bind capability needed by sites on ports 80/443 and Certbot standalone validation, while the container itself runs as the unprivileged `node` user. The default persistent directory is `/data`.

All mutable instance data persists under `SHAM_DATA_PATH`. With the supplied Compose file, sites, configuration, secrets, plugins, certificates, releases, backups, and UI-staged SHAM application updates are stored in `./sham-data` on the host. SHAM 1.0.0 stores compatible application-code updates under `/data/app-runtime`, and the image bootstrap activates that persistent release after a container recreation. Keep the same volume mounted when recreating the container. Any SHAM update that changes runtime dependencies must be delivered through a reviewed image rebuild rather than the in-app code updater.

### Published site ports

A normal Docker bridge exposes only published ports. The supplied Compose file publishes ports 4100–4199 for hosted sites, plus 80 and 443 for conventional HTTP/HTTPS listeners. Change the range to match your deployment. The Dockerfile only declares the fixed dashboard/edge ports because hosted-site listeners are dynamically allocated; Compose performs the actual range publication.

### Optional container-isolation overlay

The base Compose file deliberately does **not** mount the Docker socket. Per-site Docker isolation and managed Anubis sidecars require the optional overlay and therefore grant SHAM control over containers on the host. Use it only on a dedicated host or VM.

```bash
export SHAM_DOCKER_HOST_DATA_PATH="$(pwd)/sham-data"
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker compose -f docker-compose.yml -f docker-compose.isolation.yml up -d --build
```

`SHAM_DOCKER_HOST_DATA_PATH` must be the absolute host path mounted at `SHAM_DATA_PATH` inside SHAM. Isolated Node.js sites run with a read-only application mount, a separate writable data directory, dropped capabilities, `no-new-privileges`, process/memory/CPU limits, and an optional internal-only Docker network. Do not mount the Docker socket into a general-purpose or multi-tenant control plane.

## Safe deployments and operations

The administrator-only **Operations** workspace groups delivery, configuration, automation, backups, observability, and instance updates. Existing direct-upload sites remain compatible; every advanced feature is opt-in.

On first administrator sign-in, SHAM presents a hardening checklist rather than silently assuming production readiness. Site configuration can be exported or imported as JSON without exporting secret values, and runtime logs support reusable saved filters.

### Cloudflare Tunnel

Cloudflare Tunnel is configured **per site**. Open **Sites → Site settings → Cloudflare Tunnel** as an administrator, paste the remotely managed tunnel token for that site, and enable the connector. **Operations → Instance** shows a compact overview of all site connectors and their current local state.

Each site token is encrypted with SHAM's master key and supplied to its own `cloudflared tunnel --no-autoupdate run` process through the `TUNNEL_TOKEN` environment variable, so the secret is not exposed in process arguments or returned by the API. Connectors are supervised independently with bounded exponential backoff, can be restarted without disturbing other sites, and are stopped during graceful shutdown or site deletion.

Create the tunnel and public-hostname route in Cloudflare Zero Trust. For domain-routed traffic, the simplest layout is usually to enable SHAM's shared edge proxy and point the Cloudflare route at `http://127.0.0.1:80` inside the container. A tunnel can also target a site's directly reachable listener when that is intentional. Connector status confirms the local `cloudflared` lifecycle; verify hostname routing and replica health in Cloudflare as well.

A tunnel does not require inbound port forwarding. When Cloudflare Tunnel is the exclusive ingress path, remove unnecessary Docker port publications or bind them only to a private interface, and block direct origin access. Existing published ports remain in the default Compose file for backward compatibility.

> **Upgrading from the original instance-wide connector:** existing instance-level tunnel settings and API endpoints are retained for compatibility and continue to start automatically. New configuration should use the per-site controls; migrate the old tunnel intentionally before disabling the legacy connector so remote routes are not interrupted.

### Atomic releases, Git, webhooks, and previews

Git deployments clone into a new release directory, optionally install production dependencies, validate the entry point, start the candidate, and then switch traffic. Previous releases remain available for one-click rollback. Preview deployments receive a temporary hostname and expire automatically; they are intended for validation rather than permanent hosting.

A repository can trigger deployment through `POST /api/hooks/deploy/:id`. Configure `DEPLOY_WEBHOOK_SECRET`, send the raw webhook body, and include either `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>` or `X-SHAM-Signature: sha256=<hex HMAC-SHA256>`. Webhooks are rate-limited, branch-filtered, signature-checked with a timing-safe comparison, and serialized with other site mutations.

### Environments and attached services

Per-site environment variables support development, staging, and production scopes. Secret values are encrypted at rest and are never returned to the browser. Reusable database profiles attach an encrypted connection string to a selected environment variable without provisioning or managing the external database itself. Runtime configuration changes require a restart or a new release activation.

### Scheduled jobs

Jobs use bounded five-field cron expressions (`minute hour day month weekday`). Commands run with the selected site environment, a timeout, overlap prevention, captured output, and a manual **Run now** action. Treat job commands as trusted server-side code.

### External backups

Scheduled and manual backups can target a local path or mounted NAS, restic, S3-compatible storage, or SFTP. Restic provides repository encryption when configured with a strong password. S3 and SFTP transfers package SHAM data but rely on the destination/provider for encryption at rest; use encrypted storage or wrap the destination with restic when application-layer encryption is required. Non-interactive SFTP jobs require a dedicated unencrypted deploy key or a preconfigured SSH agent because SHAM cannot answer a key passphrase prompt. SHAM verifies locally created archives and records each result, but operators should also perform periodic restore drills.

### Optional Anubis anti-bot protection

Anubis can be enabled per hostname as a resource-limited sidecar between SHAM's shared edge proxy and the hosted site. Presets provide balanced, aggressive, search-engine-friendly, and custom policy modes. Configure exclusions for APIs, webhooks, health checks, accessibility tooling, uptime monitors, and other non-browser clients before enabling challenges. SHAM reports sidecar health and metrics and can bypass a failed sidecar. SHAM adds a loopback-only metrics listener to generated and custom policies; the top-level `metrics` section is reserved so the performance monitor always knows where to collect sidecar telemetry.

Anubis is an anti-scraping/challenge layer, not volumetric DDoS protection. Keep origin access restricted and use Cloudflare or another upstream network service for traffic absorption. The image is pinned to `ghcr.io/techarohq/anubis:v1.26.2` by default so policy behavior does not change unexpectedly.

### Routing, certificates, and response policy

Sites can define maintenance HTML, custom 4xx/5xx pages, path redirects, cache rules, custom headers, CSP/security-header presets, and domain-only access. The shared edge proxy supports normal and wildcard certificates. Cloudflare DNS-01 issuance can request wildcard names without stopping the HTTP listener; standalone HTTP validation remains available for ordinary certificates. WebSocket counts are exposed in runtime status and Prometheus metrics.

### Logs, alerts, metrics, and status

Runtime logs support bounded search and saved filters. Audit logs can be exported by administrators. Alert destinations support generic webhooks, Slack-compatible webhooks, Discord-compatible webhooks, and local sendmail. Prometheus and OpenTelemetry exports are optional and token/header protected. The public status page is read-only and exposes only coarse availability information. English, Dutch, and German interface locales are available.

### Safe SHAM updates

Update ZIPs are extracted and verified in a worker. Signed updates use Ed25519 publisher keys shared with the plugin trust store; unsigned archives require explicit acknowledgement. SHAM backs up managed application files, stages the update, and rolls back if the new process fails its startup check. Dependency-changing updates are rejected from in-place staging and must be installed through a normal reviewed release process.

A signed update includes a root `sham-update.json` similar to:

```json
{
  "format": "sham-update-signature-v1",
  "algorithm": "ed25519",
  "version": "1.0.0",
  "keyId": "publisher-key-id",
  "value": "base64url-signature"
}
```

## GitHub releases and container publishing

The repository includes GitHub Actions workflows for pull-request validation, Docker build testing, GitHub Container Registry publishing, and tagged GitHub releases. See [RELEASING.md](RELEASING.md) for the exact repository settings and release commands.

A pushed tag such as `v1.0.0` publishes multi-platform images to:

```text
ghcr.io/<owner>/<repository>:1.0.0
ghcr.io/<owner>/<repository>:1.0
ghcr.io/<owner>/<repository>:1
ghcr.io/<owner>/<repository>:latest
```

The release workflow also creates a clean source archive and SHA-256 checksum. The workflows use the repository-scoped `GITHUB_TOKEN`; no Docker Hub credentials are needed for GHCR.

## Configuration

SHAM loads `.env` from the project root. Existing process environment variables take precedence.

| Variable | Default | Description |
|---|---:|---|
| `SHAM_HOST` | `127.0.0.1` | Dashboard bind address. |
| `SHAM_PORT` | `8080` | Dashboard port. |
| `SHAM_DATA_PATH` | `./data` | Persistent database, sites, plugins, JWT secret, and certificates. |
| `SHAM_TRUST_PROXY` | `loopback` | Express trust-proxy value. |
| `SHAM_UPLOAD_LIMIT_MB` | `100` | Maximum uploaded and uncompressed project size. |
| `SHAM_UPLOAD_WORKERS` | `2` | Maximum concurrent project extraction/install workers. |
| `SHAM_UPLOAD_QUEUE_LIMIT` | `16` | Maximum queued and active project uploads before new uploads are rejected temporarily. |
| `SHAM_EDITOR_LIMIT_MB` | `2` | Maximum text file size accepted by the editor. |
| `SHAM_NODE_START_TIMEOUT_SECONDS` | `30` | Time allowed for a Node app to open its assigned internal port. |
| `SHAM_NPM_INSTALL_TIMEOUT_SECONDS` | `600` | Maximum time for managed `npm install`. |
| `SHAM_NPM_INSTALL_WORKERS` | `2` | Maximum concurrent managed dependency installations. |
| `SHAM_NPM_INSTALL_QUEUE_LIMIT` | `32` | Maximum waiting dependency installations before SHAM returns a busy error. |
| `SHAM_REQUEST_TIMEOUT_SECONDS` | `300` | Time allowed to receive a dashboard or hosted-site HTTP request, including uploads. |
| `SHAM_STATS_FLUSH_SECONDS` | `2` | Interval for batching request-statistics writes to SQLite. |
| `SHAM_MINIFY_MAX_MB` | `5` | Largest individual static asset that SHAM will minify. |
| `SHAM_MINIFY_CACHE_MB` | `32` | Approximate in-memory cap for transformed response data. |
| `SHAM_MINIFY_WORKERS` | `2` | Maximum concurrent static asset transformation workers. |
| `SHAM_MINIFY_QUEUE_LIMIT` | `64` | Maximum queued/active transformations before SHAM temporarily serves original assets. |
| `SHAM_COMPRESSION_WORKERS` | `4` | Maximum concurrent on-demand Brotli/Gzip jobs. |
| `SHAM_COMPRESSION_QUEUE_LIMIT` | `128` | Maximum queued compression jobs before SHAM serves the uncompressed response. |
| `SHAM_INTEGRATION_TIMEOUT_SECONDS` | `20` | Cloudflare API request timeout. |
| `SHAM_VISITOR_RETENTION_DAYS` | `90` | Maximum age for detailed visitor-IP records. Aggregate daily statistics remain available. |
| `SHAM_VISITOR_PENDING_BUCKETS` | `50000` | Maximum in-memory visitor identities waiting for a statistics flush. |
| `SHAM_AUTH_RATE_LIMIT_BUCKETS` | `10000` | Maximum in-memory authentication rate-limit identities. |
| `SHAM_FIREWALL_RATE_LIMIT_BUCKETS` | `50000` | Maximum in-memory per-site firewall rate-limit identities. |
| `SHAM_CERTBOT_BIN` | `certbot` | Certbot executable path. |
| `SHAM_JWT_SECRET` | generated | JWT signing secret; must be at least 32 characters when supplied. |
| `SHAM_MASTER_KEY` | generated keyring | Optional 32-byte hex or base64url key used to encrypt saved secrets. Prefer a container secret in production. |
| `SHAM_PERFORMANCE_INTERVAL_SECONDS` | `5` | Live performance sampling interval. |
| `SHAM_PERFORMANCE_HISTORY_SAMPLES` | `720` | In-memory history samples retained for charts. |
| `SHAM_PERFORMANCE_SITE_CONCURRENCY` | `8` | Maximum concurrent per-site process-memory samples. |
| `SHAM_DEPENDENCY_SCAN_TIMEOUT_SECONDS` | `120` | Maximum npm-audit duration. |
| `SHAM_DEPENDENCY_SCAN_WORKERS` | `1` | Concurrent dependency scans. |
| `SHAM_DEPENDENCY_SCAN_QUEUE_LIMIT` | `16` | Maximum queued dependency scans. |
| `SHAM_SNAPSHOT_RETENTION` | `10` | Maximum retained snapshots per site. |
| `SHAM_SNAPSHOT_WORKERS` | `1` | Concurrent snapshot/archive workers. |
| `SHAM_SNAPSHOT_QUEUE_LIMIT` | `8` | Maximum queued snapshot operations. |
| `SHAM_PLUGIN_ACTION_TIMEOUT_SECONDS` | `15` | Maximum plugin startup/action time. |
| `SHAM_PLUGIN_MAX_PENDING_ACTIONS` | `32` | Maximum pending actions per isolated plugin. |
| `SHAM_EDGE_HOST` | `0.0.0.0` | Shared edge listener address. |
| `SHAM_EDGE_HTTP_PORT` | `0` | Shared HTTP edge port; `0` disables it. |
| `SHAM_EDGE_HTTPS_PORT` | `0` | Shared HTTPS/SNI edge port; `0` disables it. |
| `SHAM_CLOUDFLARED_BIN` | `cloudflared` | Cloudflare Tunnel connector executable. The supplied Docker image includes a pinned binary. |
| `SHAM_DOCKER_BIN` | `docker` | Docker executable used for isolated sites and Anubis sidecars. |
| `SHAM_DOCKER_HOST_DATA_PATH` | unset | Absolute host path corresponding to `SHAM_DATA_PATH` when SHAM itself runs in Docker. |
| `SHAM_DOCKER_INTERNAL_NETWORK` | `sham-internal` | Docker network used by isolated sites that must not have outbound internet access. The isolation overlay sets a shared internal network name. |
| `SHAM_DOCKER_EGRESS_NETWORK` | unset | Docker network used by isolated sites with outbound access. The isolation overlay supplies a shared egress network. |
| `SHAM_GIT_BIN` | `git` | Git executable used for release deployments. |
| `SHAM_TAR_BIN` | `tar` | Archive executable used by backup workflows. |
| `SHAM_RESTIC_BIN` | `restic` | Restic executable used for encrypted repositories. |
| `SHAM_AWS_BIN` | `aws` | AWS CLI used for S3-compatible transfers. |
| `SHAM_SFTP_BIN` | `sftp` | SFTP executable used for remote transfers. |
| `SHAM_ANUBIS_IMAGE` | pinned stable image | Anubis sidecar image. Keep it pinned and review policy changes before upgrading. |
| `SHAM_JOB_POLL_SECONDS` | `15` | Scheduler polling interval. |
| `SHAM_JOB_TIMEOUT_SECONDS` | `900` | Maximum scheduled-job runtime. |
| `SHAM_BACKUP_TIMEOUT_SECONDS` | `3600` | Maximum backup runtime. |
| `SHAM_GIT_TIMEOUT_SECONDS` | `600` | Maximum Git deployment stage duration. |
| `SHAM_PREVIEW_TTL_HOURS` | `24` | Default preview expiration. |
| `DEPLOY_WEBHOOK_SECRET` | unset | HMAC secret for signed Git deployment webhooks. |
| `NODE_ENV` | `development` | Runtime mode passed to SHAM and managed Node.js applications. Authentication cookies are marked Secure automatically when the dashboard request is HTTPS. |

## Static sites

A static upload must contain the configured entry file, normally `index.html`.

```text
website/
├── index.html
├── styles.css
├── app.js
└── assets/
    └── logo.svg
```

SHAM accepts one standard, non-encrypted ZIP archive or a selected/dropped folder. A single enclosing top-level directory is removed during installation. The browser checks ZIP signatures and verifies the configured entry path for folder selections before sending data. Uploads stream to disk, are validated and assembled outside the HTTP request thread, then are atomically committed. A failed full replacement leaves the old project intact.

### Upload troubleshooting

- **Entry file not found:** the configured path is evaluated after one common top-level folder is removed. For `website/index.html`, use `index.html`; for `website/public/index.html`, use `public/index.html`.
- **ZIP cannot be opened:** create a normal ZIP with Deflate or Store compression. Do not use an encrypted archive, a renamed `.tar.gz`/`.7z`, or a split/multi-volume ZIP.
- **Temporary file is no longer readable / `ENOENT`:** confirm that `SHAM_DATA_PATH` is writable by the SHAM process and that no external cleanup job deletes `<SHAM_DATA_PATH>/tmp`. In Docker, check the mounted directory ownership and keep the same persistent volume attached.
- **Upload rejected or connection closes:** compare the archive and uncompressed project size with `SHAM_UPLOAD_LIMIT_MB`, the file count with the 2,000-file limit, and any reverse-proxy body-size or timeout settings with `SHAM_REQUEST_TIMEOUT_SECONDS`.
- **Folder chooser behaves differently by browser:** use the **Choose folder** control in a current Chromium, Firefox, or Safari release. When a browser or remote client cannot preserve folder-relative paths, upload a ZIP instead.

Upload errors use actionable server-side messages and do not rely on the browser's local file path, which is never available to SHAM.

### Static options

- **Entry file:** served for `/`.
- **SPA fallback:** serves the entry file for unmatched GET and HEAD requests.
- **Cache seconds:** controls browser cache max-age.
- **Minify:** minifies HTML, CSS, JS, and MJS while serving them. Source files remain unchanged.
- **Obfuscate JavaScript:** applies compatibility-oriented compression and local-name mangling while preserving top-level names, properties, function names, and class names. Enabling it requires a risk acknowledgement and a compatibility report is available for existing sites. Transformation failures automatically serve the original asset.
- **Custom headers:** JSON object applied to every response.

### Access and firewall options

- **Domain-only access:** rejects requests whose `Host` header does not exactly match the configured domain. This blocks casual IP-address access but does not hide a publicly reachable origin.
- **Local firewall:** supports IP/CIDR allow and block lists, country allow and block lists, per-IP fixed-window rate limits, a request-body cap, and a basic automated-client filter.
- **Cloudflare firewall:** synchronizes the configured IP and country policy to a hostname-scoped custom WAF rule. Save the site first, then choose **Sync Cloudflare firewall** from its menu.
- **Both:** applies supported local controls at the origin and the IP/country rule at Cloudflare.

Country decisions at the local firewall use `CF-IPCountry` only when the direct peer is a published Cloudflare network or is explicitly listed in `SHAM_TRUSTED_EDGE_PROXIES`. Public direct-origin requests cannot supply trusted Cloudflare identity headers. Keep Cloudflare IP ranges and origin firewall rules current, and prevent direct public access when Cloudflare is the intended protection layer.

## Node.js sites

Select **Node.js server** when creating or editing a site. SHAM starts the configured entry using the Node executable running SHAM:

```text
node server.js
```

The child process receives:

| Variable | Meaning |
|---|---|
| `PORT` | An internal loopback port selected by SHAM. The app must listen here. |
| `HOST` | Always `127.0.0.1` for the managed child. |
| `SHAM_PUBLIC_PORT` | The public site port configured in SHAM. |
| `SHAM_SITE_ID` | Site database ID. |
| `SHAM_SITE_DOMAIN` | Configured domain, or an empty string. |

Minimal example:

```js
const express = require('express');
const app = express();

app.get('/', (_req, res) => res.send('Hello from SHAM'));
app.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
```

SHAM proxies the public listener to the internal child process. This gives Node applications the same request statistics and TLS listener support as static sites. WebSocket upgrades are proxied as well.

### Dependencies

Enable **Run npm install before starting** to execute:

```text
npm install --omit=dev --no-audit --no-fund
```

With automatic installation enabled, SHAM fingerprints `package.json`, `package-lock.json`, and `npm-shrinkwrap.json`; it skips `npm install` when the dependency manifests and existing `node_modules` are unchanged. You can also run the operation manually from a site's **More** menu. A manual install temporarily stops an active site, installs dependencies, and starts it again.

The repository includes `examples/node-server/`.

## File browser and document editor

Choose **Files** on a site to:

- Browse project files. `node_modules`, `.git`, and `.sham` are hidden from the browser.
- Open UTF-8 text files up to the configured editor limit.
- Create or save a text document.
- Replace one file with an uploaded file.
- Delete one file.
- Restart the site after server-side changes.

Deleting the configured static or Node entry file stops and disables the site.

Static file changes are available immediately. A running Node.js process normally needs a restart before server-side code changes take effect.

## Statistics

SHAM records statistics at the public listener for static and Node.js sites:

- Total requests.
- Response bytes.
- HTTP 4xx/5xx responses.
- Total response time and average response time.
- Last request time.
- Daily requests, bytes, and errors for the overview chart.
- Most recently observed visitor IP addresses.
- Country request and visitor totals, plus an overview traffic map.

Statistics are accumulated in memory and written to SQLite in short batches to avoid a synchronous database write for every request. They survive restarts; the flush interval is configurable. Daily detail is indexed by date and retained for 400 days, while lifetime totals remain available for each site. Visitor detail is bounded to the 5,000 most recently updated IP/country rows per site.

The traffic map uses simplified Natural Earth country boundaries projected with Equal Earth. Country values are still only as accurate as the trusted `CF-IPCountry` metadata supplied by Cloudflare; direct-origin requests remain `Unknown`.

### JavaScript obfuscation safety

Obfuscation is deliberately conservative. SHAM does not mangle top-level names or properties, preserves function and class names, avoids Terser unsafe transforms, and serves the original file when transformation itself fails. It still cannot prove runtime compatibility for code that uses `eval`, the `Function` constructor, string timers, generated source, function-source inspection, or dynamic global-name lookups. Enabling obfuscation therefore requires an explicit acknowledgement. Existing sites can run a bounded compatibility report before saving, and SHAM warns again when obfuscation is enabled or obfuscated content is replaced. Always test the deployed site. Obfuscation is not encryption or a security boundary.

Country data is available when requests arrive through a trusted Cloudflare edge or reverse proxy that supplies `CF-IPCountry`; direct requests are recorded as country `Unknown`. IP addresses are personal data in many jurisdictions. Operators are responsible for providing suitable notice, access controls, retention choices, and legal basis for collection.

## Security, recovery, and performance

### Account security

The **Security** page lets each user add TOTP, download one-time recovery codes, and register WebAuthn passkeys. Password login becomes a two-step flow when TOTP or a passkey is configured. Sensitive account changes such as disabling TOTP, regenerating recovery codes, deleting a passkey, or rotating the master key require password confirmation.

Saved Cloudflare tokens, password-type plugin settings, and TOTP seeds are encrypted with AES-256-GCM. Without `SHAM_MASTER_KEY`, SHAM creates a mode-0600 keyring under the data path. Administrators can rotate that generated key from the Instance page. Back up the keyring with the database; encrypted values cannot be recovered without it.

### Performance monitor

The **Performance** page samples the SHAM process and hosted runtimes without writing on every request. It shows:

- Dashboard CPU, RSS/heap memory, load, event-loop mean/p99 delay, storage use, and uptime.
- Upload, transformation, dependency-install, dependency-scan, and snapshot queue pressure.
- Per-site process memory, health state, connection count, restart count, request rate, response throughput, recent error percentage, and sampled average latency.
- Configurable CPU, event-loop, disk, traffic-spike, and site-error-rate alerts.

Traffic baselines use an exponentially weighted recent average and require a warm-up period. Alerts are intentionally advisory: a traffic spike can be legitimate, and operators should correlate alerts with Activity/runtime logs before blocking traffic.

### Site safety controls

Each site can enable compression, shared edge routing, security-header presets, a custom CSP, health probes, restart policies, crash-loop limits, memory limits, and connection limits. Static sites can serve newer `.br` or `.gz` sidecars; otherwise SHAM compresses eligible responses dynamically. Balanced HTTPS sites receive HSTS for the exact hostname, while Strict additionally includes subdomains.

The site tools dialog provides manual snapshots and dependency scans. SHAM also creates automatic rollback snapshots before full project replacement and snapshot restore. Dependency scans combine bounded static checks with `npm audit --omit=dev --json` when a lockfile is available.

## Appearance and themes

The default dashboard theme is purple. Use the appearance button in the sidebar footer to switch between Purple, Midnight, Emerald, Light, or Custom. Custom themes store accent, background, panel, text, and corner-radius preferences in the current browser's `localStorage`; they do not change server data or other users' browsers.

## SSL with Certbot

1. Configure a domain on the site.
2. Add a Certbot contact email under **Instance → Cloudflare and Certbot**.
3. Choose **Issue / renew SSL** from the site's menu.

When a Cloudflare API token is configured, SHAM uses the Certbot Cloudflare DNS challenge. Otherwise it uses Certbot standalone HTTP validation, which requires inbound port 80 and no conflicting listener. SHAM temporarily stops hosted listeners using port 80 during standalone issuance and restores them afterward. If the dashboard itself is configured on port 80, use the Cloudflare DNS challenge or move the dashboard because it cannot stop its own listener while handling the request.

Certificates are stored under:

```text
<SHAM_DATA_PATH>/certbot/config/live/<domain>/
```

After successful issuance, SHAM enables HTTPS for that site's configured port. The **Renew certificates** administrator action runs `certbot renew` and restarts active SSL sites so renewed files are loaded.

### Network considerations

- Let's Encrypt validation must be able to reach the domain or its authoritative DNS.
- A direct HTTPS site normally uses port 443.
- Binding a port does not configure a firewall, router, NAT, security group, or Docker publishing rule.
- The dashboard itself should normally remain private behind a reverse proxy, VPN, or identity-aware access layer.

## Cloudflare support

Under **Instance**, configure:

- A restricted Cloudflare API token with DNS edit access for the intended zone.
- The Cloudflare zone ID.
- The public IPv4 address of the SHAM origin.

Then set a site domain and choose **Sync Cloudflare DNS**. SHAM creates or updates an A record with automatic TTL and `proxied: true`. Saving or clearing the token also updates the restricted Certbot credential file used for DNS renewals. Sites using Cloudflare or Both firewall mode can separately choose **Sync Cloudflare firewall** to create, update, or remove the SHAM-managed hostname rule.

Changing a site domain marks its Cloudflare DNS state as unsynchronized. Sync the new hostname afterward. SHAM does not automatically delete the old external DNS record, because it may still be used elsewhere; remove it in Cloudflare when it is no longer needed.

A proxied record routes supported traffic through Cloudflare only when the visitor-facing protocol and port are supported. Prefer a reverse proxy on ports 80/443 (or another currently supported Cloudflare proxy port) in front of SHAM sites. A proxied DNS record alone does not protect an origin that remains directly reachable, so restrict origin access to trusted networks or Cloudflare source ranges and expose only required ports. SHAM warns when a site's configured port is outside Cloudflare's standard proxy-port set.

For outbound-only ingress, create a remotely managed tunnel in Cloudflare Zero Trust and paste its connector token under **Sites → Site settings → Cloudflare Tunnel**. Each site gets an independent `cloudflared tunnel --no-autoupdate run` lifecycle with the token supplied through `TUNNEL_TOKEN`. The DNS/WAF API token under **Instance** is separate from site tunnel connector tokens and should keep only the permissions needed for DNS, firewall, and Certbot workflows.

## Plugin system

Plugins are ZIP archives with `plugin.json` at the archive root. Installed plugins are disabled until an administrator enables them.

Plugins can be:

- **JSON:** declarative dashboard cards, pages, and parameterized database actions without executable server code. Read actions must be one comment-free `SELECT` statement. Write actions must be one comment-free `INSERT`, `UPDATE`, or `DELETE` statement, require an administrator, and require a non-GET request. Declarative SQL cannot access authentication, instance-secret, plugin-setting, audit, or SQLite schema tables, and cannot write site/plugin lifecycle rows directly.
- **JavaScript:** trusted server modules with API actions and an optional browser client.

The Documentation page contains downloadable examples for both formats. Source copies are also under `examples/plugins/`.

### JSON plugin

```json
{
  "id": "welcome-cards",
  "name": "Welcome Cards",
  "version": "1.0.0",
  "type": "json",
  "settings": [
    { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello" }
  ],
  "queries": {
    "siteCount": {
      "mode": "get",
      "sql": "SELECT COUNT(*) AS count FROM sites"
    }
  },
  "ui": {
    "dashboardCards": [
      {
        "label": "Configured sites",
        "action": "siteCount",
        "valuePath": "count",
        "description": "Declarative database query"
      }
    ],
    "pages": [
      {
        "id": "welcome",
        "title": "Welcome",
        "description": "A plugin page",
        "cards": [
          { "label": "Sites", "action": "siteCount", "valuePath": "count" }
        ]
      }
    ]
  }
}
```

### JavaScript manifest

```json
{
  "id": "site-notes",
  "name": "Site Notes",
  "version": "1.0.0",
  "type": "js",
  "main": "index.js",
  "client": "client.js",
  "isolation": "worker",
  "permissions": ["data:read", "settings:read", "ui:dashboard"],
  "settings": [
    { "key": "heading", "label": "Heading", "type": "text", "default": "Sites" }
  ]
}
```

### Plugin permissions, signatures, and isolation

A manifest may declare these permissions:

- `data:read` / `data:write`
- `settings:read` / `settings:write`
- `ui:dashboard`
- `network:outbound`
- `runtime:read` / `runtime:manage`

JSON plugins infer only the permissions required by their declared queries, settings, and UI. JavaScript plugins should request the minimum explicit set. Runtime management is exposed through `runtime.list()`, `runtime.status(id)`, `runtime.start(id)`, `runtime.stop(id)`, and `runtime.restart(id)` when permitted.

Set `"isolation": "worker"` for a JavaScript plugin to run its server module in a worker with a restricted `require()` surface and bounded RPC/actions. This limits accidental interference but is not an OS sandbox. In-process plugins remain fully trusted code.

Signed packages use an Ed25519 signature object in `plugin.json` with `algorithm`, `keyId`, and `value`. Administrators add trusted public keys under **Instance → Security and trust**. Unsigned packages require a per-install acknowledgement unless the administrator explicitly allows them.

### Server module

```js
exports.activate = ({ data, settings, log }) => ({
  api: {
    async summary() {
      return {
        heading: settings.get('heading', 'Sites'),
        sites: await data.all('SELECT id, name, runtime_type FROM sites')
      };
    }
  },
  deactivate() {
    log('Plugin stopped');
  }
});
```

The activation context provides:

- `data.all(sql, params)`
- `data.get(sql, params)`
- `data.run(sql, params)`
- `settings.get(key, fallback)`
- `settings.all()`
- `settings.set(key, value)`
- `runtime.list()` / `runtime.status(siteId)`
- `runtime.start(siteId)` / `runtime.stop(siteId)` / `runtime.restart(siteId)`
- `log(message)`

The data API is intentionally powerful. JavaScript plugins are trusted code and can modify SHAM's database. `activate()` must return synchronously; API handlers and lifecycle hooks may perform asynchronous work.

Plugin API handlers are available at:

```text
/api/plugins/<plugin-id>/actions/<action-name>
```

A handler receives `body`, `query`, `method`, `user`, `data`, and `settings`. It can return any JSON-serializable value, or `{ status, body }` to choose an HTTP status.

### Browser client

```js
window.SHAM.registerPlugin({
  id: 'site-notes',
  name: 'Site Notes',
  pages: [
    {
      id: 'inventory',
      title: 'Site inventory',
      async render(container, context) {
        const result = await context.api('/api/plugins/site-notes/actions/summary');
        container.textContent = JSON.stringify(result, null, 2);
      }
    }
  ]
});
```

Browser plugins can add overview cards and navigation pages, call authenticated APIs, read the current user and site list through the supplied context, and modify their own UI container. Render inside the supplied container and reuse SHAM classes such as `panel`, `stat-card`, `table-wrap`, `button`, `muted`, and `notice` so plugin pages inherit the same theme. Do not replace the dashboard shell or global navigation. Register a `deactivate()` lifecycle hook when the client attaches timers, observers, or global listeners. SHAM awaits cleanup during disable, deletion, reload, and shutdown, with a bounded timeout so a faulty plugin cannot block the dashboard indefinitely.

### Plugin lifecycle

- Install ZIP.
- Review declared settings.
- Enable or disable the plugin.
- Open the plugin's dedicated settings page and save its configuration.
- Delete the plugin and its stored settings.

Disabled plugins do not load their server module or browser client. Password-type plugin values are never returned by the API; the UI receives only a configured/not-configured indicator. Leaving a secret blank preserves it, while the explicit clear control removes it.

## Authentication and roles

- The first registered account is an administrator.
- Registration locks immediately after bootstrap.
- Administrators can reopen registration, manage users, configure integrations, issue certificates, and manage plugins.
- Users can create, configure, start, stop, edit, replace, and delete sites.
- Each user can enable TOTP, store recovery codes offline, and register passkeys.
- SHAM prevents disabling or deleting the final active administrator.

Passwords are hashed with asynchronous Node.js `scrypt` so authentication does not block the event loop. Sessions use signed JWTs in HttpOnly, SameSite=Strict cookies. Cookies are marked Secure whenever the dashboard request is HTTPS, including through a correctly configured trusted proxy.

### Public endpoints and data exposure

The dashboard shell and static assets are public so the login page can load. Operational APIs require a valid session, and administrator APIs also verify the current database role. The intentional unauthenticated surfaces are:

- `GET /api/health`: returns only `{ "ok": true }`.
- `GET /api/bootstrap`: returns setup/registration state and the current user only when a valid session cookie is present.
- `GET /api/public/status` and `GET /status`: disabled by default; when enabled they publish service names and coarse health states, but not domains, ports, logs, configuration, or secrets.
- `GET /metrics`: available only when enabled and supplied with the configured bearer token; it fails closed when the token is missing.
- `POST /api/hooks/deploy/:id`: requires an HMAC signature and a unique delivery identifier. Invalid, missing, and unknown-site requests receive the same response, and deployment failures are logged internally instead of returning paths or command output.

All other declared `/api/*` routes require authentication. Site and plugin mutations authenticate before entering their serialization queues.

### Outbound trust boundaries

SHAM sends data externally only through administrator-configured features: Cloudflare DNS/WAF calls, Git/npm/Certbot operations, alert destinations, OpenTelemetry, and local/restic/S3/SFTP backups. Alert and OpenTelemetry HTTP requests reject redirects before sending custom headers or payloads; Cloudflare API requests do the same before sending its bearer token. Backup destinations receive a complete control-plane archive and must be treated as sensitive. OpenTelemetry exports only SHAM process gauges, while alert messages may include operational details and a site ID.

Git repository URLs must use HTTPS, SSH, or strict `git@host:path` syntax. Embedded HTTP credentials and `file://` repositories are rejected so tokens cannot enter shared site metadata and local host repositories cannot be published accidentally.

## Data and backups

Back up the entire configured data path:

```text
<SHAM_DATA_PATH>/
├── .jwt-secret
├── .master-keyring.json
├── sham.db
├── sham.db-shm
├── sham.db-wal
├── sites/
├── plugins/
├── snapshots/
├── releases/
├── previews/
├── backups/
├── site-data/
├── updates/
└── certbot/
```

SHAM uses `better-sqlite3` directly rather than an ORM. Queries use bound parameters; the few dynamic schema and placeholder fragments are constructed only from fixed table/column definitions or generated `?` placeholders. SQLite enables WAL, foreign keys, and a busy timeout, and includes indexes for global recent-visitor and IP lookups.

Database, WAL, shared-memory, upload, snapshot, update, backup, keyring, and temporary credential files are tightened to owner-only permissions on POSIX systems. Sensitive data directories are owner-only where SHAM controls their modes. Failed backup runs remove partial local archives. External local backup copies are also created with owner-only file permissions.

Stop SHAM for a simple consistent filesystem backup. SQLite WAL files can contain recent committed data. A SHAM backup includes the database, JWT secret, encryption keyring, certificates, and hosted data; possession of both an archive and its key material can expose saved secrets, so secure and encrypt backup destinations independently.

## API overview

Authentication:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/bootstrap` | Setup, registration, and session state. |
| `POST` | `/api/auth/register` | Bootstrap or open registration. |
| `POST` | `/api/auth/login` | Start a dashboard session. |
| `POST` | `/api/auth/logout` | End a dashboard session. |
| `GET` | `/api/security` | Current MFA/passkey status. |
| `POST` | `/api/security/totp/*` | Configure, enable, disable, or recover TOTP. |
| `POST` | `/api/security/passkeys/*` | Register and verify passkeys. |
| `DELETE` | `/api/security/passkeys/:id` | Delete a passkey with password confirmation. |

Sites and files:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/sites` | List sites and runtime state. |
| `POST` | `/api/sites` | Upload a static or Node.js site. |
| `PUT` | `/api/sites/:id` | Update configuration. |
| `PATCH` | `/api/sites/:id/toggle` | Start or stop. |
| `POST` | `/api/sites/:id/restart` | Restart. |
| `POST` | `/api/sites/:id/npm-install` | Run managed npm install. |
| `PUT` | `/api/sites/:id/content` | Atomically replace all project files. |
| `GET` | `/api/sites/:id/files` | List browser-visible files. |
| `GET` | `/api/sites/:id/files/content` | Read a text document. |
| `PUT` | `/api/sites/:id/files/content` | Create or save a text document. |
| `PUT` | `/api/sites/:id/files/upload` | Replace one file. |
| `DELETE` | `/api/sites/:id/files` | Delete one file. |
| `DELETE` | `/api/sites/:id` | Delete a site and its files. |
| `GET` | `/api/statistics` | Aggregate and per-site traffic statistics. |
| `GET` | `/api/performance` | Authenticated live performance history and alerts. |
| `GET/POST` | `/api/sites/:id/snapshots` | List or create restore points. |
| `POST` | `/api/sites/:id/snapshots/:snapshotId/restore` | Restore a snapshot with an automatic rollback point. |
| `GET/POST` | `/api/sites/:id/dependency-scan` | Read or run dependency security scans. |

Operations:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/sites/:id/operations` | Read release, environment, job, preview, and attachment state. |
| `POST` | `/api/sites/:id/deploy/git` | Build and activate an atomic Git release. |
| `POST` | `/api/hooks/deploy/:id` | HMAC-authenticated repository webhook deployment. |
| `POST` | `/api/sites/:id/releases/:releaseId/rollback` | Activate a retained release. |
| `POST/DELETE` | `/api/sites/:id/previews` | Create or remove an expiring preview. |
| `GET/PUT` | `/api/sites/:id/environment` | Read metadata or save encrypted environment variables. |
| `GET/POST` | `/api/sites/:id/jobs` | Manage scheduled jobs. |
| `POST` | `/api/admin/backups/run` | Run an external backup immediately. |
| `GET` | `/api/runtime-logs/search` | Search bounded structured logs. |
| `GET` | `/api/admin/audit/export` | Export the administrator audit log. |
| `GET` | `/metrics` | Optional token-protected Prometheus metrics. |
| `GET` | `/status` | Optional public read-only status page. |
| `POST/DELETE` | `/api/admin/update` | Stage or cancel a reviewed SHAM update. |

Integrations and plugins:

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/admin/sites/:id/cloudflare` | Create or update a proxied DNS record. |
| `POST` | `/api/admin/sites/:id/certificate` | Issue a certificate and enable SSL. |
| `POST` | `/api/admin/certificates/renew` | Renew certificates. |
| `GET` | `/api/plugins` | List installed plugins. |
| `POST` | `/api/admin/plugins` | Install a plugin ZIP. |
| `PATCH` | `/api/admin/plugins/:id/toggle` | Enable or disable a plugin. |
| `PUT` | `/api/admin/plugins/:id/settings` | Save plugin settings. |
| `DELETE` | `/api/admin/plugins/:id` | Delete a plugin. |

## Development and verification

```bash
npm install
npm run dev
```

Verification:

```bash
npm run check
npm test
```

Top-level dependency versions are pinned exactly. The Docker build runs `npm audit --omit=dev --audit-level=high` and fails when npm reports a high- or critical-severity production dependency advisory. ZIP handling uses `adm-zip` 0.6.0, which bounds allocations from attacker-controlled ZIP size metadata. The multipart upload dependency is pinned to Multer 2.2.0 and every upload parser sets `fieldNestingDepth: 0` because SHAM does not use bracket-nested multipart fields. Authentication is pinned to `jsonwebtoken` 9.0.3 so its `jws` dependency resolves to the patched 4.0.1 line. Run `npm install` in a networked development environment and commit the generated `package-lock.json`. Until that file is committed, pull-request CI and local Docker builds deliberately fall back to `npm install`. Version-tag publishing fails closed without the lockfile. The manual **Prepare lockfile** workflow creates a pull request containing it.

`npm run check` performs syntax checks. The regression tests cover bounded WebAuthn/CBOR parsing, password and challenge hardening, path and header validation, static/Node runtime input, protected editor paths and invalid text, disk-streamed aggregate upload limits, worker-safe temporary upload ownership, bounded worker queues, atomic project installation and rollback, listener timeouts, certificate/edge coordination, MFA vectors, authenticated secret encryption, passkey step-up deletion, plugin permissions/isolation/signatures, dependency and snapshot lifecycle, performance/anomaly telemetry, proxy trust boundaries, privacy retention, theme persistence, responsive interaction guards, and runtime recovery.

## Project structure

```text
sham/
├── public/                  Dashboard and downloadable plugin examples
├── src/
│   ├── config.js            Paths and environment configuration
│   ├── db.js                SQLite schema and migrations
│   ├── file-utils.js        File browser and editor operations
│   ├── integrations.js      Cloudflare API and Certbot execution
│   ├── cloudflare-tunnel.js  Supervised per-site and legacy tunnel connectors
│   ├── secret-store.js      Encrypted secret storage and rotation
│   ├── mfa.js / webauthn.js TOTP, recovery codes, and passkeys
│   ├── performance-monitor.js Live telemetry and alerts
│   ├── dependency-scanner.js Bounded package vulnerability scans
│   ├── snapshot-manager.js  Snapshot queue, retention, and rollback
│   ├── edge-proxy.js        Shared domain/SNI proxy for 80/443
│   ├── plugin-signing.js    Signed package verification
│   ├── plugin-manager.js    Plugin install, lifecycle, settings, and API
│   ├── minify-worker.js     Off-thread static asset transformations
│   ├── site-manager.js      Static/Node runtimes, proxying, minification, stats
│   ├── upload-utils.js      Safe atomic project installation and worker entry
│   └── server.js            Dashboard API and entry point
├── examples/
│   ├── hello-site/
│   ├── node-server/
│   └── plugins/
├── test/
├── scripts/                 Release-readiness checks
├── .github/                 CI, container publishing, issue, and PR templates
├── AUDIT-REPORT.md          Correctness, performance, security, and UX audit notes
├── CHANGELOG.md             Public release history
├── CONTRIBUTING.md          Contribution and review process
├── RELEASING.md             GitHub release and GHCR setup
├── SECURITY.md              Private vulnerability reporting policy
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Security notes

- Keep the dashboard private whenever possible.
- Do not run SHAM as root.
- Treat uploaded Node.js projects and JavaScript plugins as fully trusted code.
- Use a dedicated container, VM, or operating-system account.
- Mount only the storage SHAM needs.
- Use a restricted Cloudflare API token instead of a global API key.
- Restrict direct origin access when using Cloudflare.
- Keep Node.js, npm dependencies, Certbot, and the base image updated.
- Review custom response headers and application-level security headers.
- Back up the database, JWT secret, encryption keyring, sites, snapshots, plugins, and certificates; encrypt and access-control every destination.
- Treat alert, OpenTelemetry, Git, Cloudflare, and backup endpoints as administrator-controlled outbound trust boundaries.
- Never embed credentials in Git URLs; use deploy keys or an external credential helper.

## License

SHAM is licensed under the GNU Affero General Public License, version 3 or (at your option) any later version (`AGPL-3.0-or-later`). See [LICENSE](LICENSE) for the complete terms. SHAM is provided without warranty; modified and redistributed versions must preserve the applicable AGPL notices, corresponding-source obligations, and network-interaction source-offer requirements.

## Scope boundaries

SHAM intentionally remains a focused self-hosted deployment control plane. It does not include domain registration, email hosting, billing/customer tenancy, a public plugin marketplace, Kubernetes orchestration, built-in managed databases, or a full browser IDE. External databases are attached through encrypted connection profiles, and advanced network functions should remain behind a dedicated reverse proxy, CDN, firewall, or isolated host where appropriate.
