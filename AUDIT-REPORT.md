# SHAM 1.0.0 Full Feature, Security, Database, Performance, and UX Audit

**Project:** Simple Hosting And More (SHAM)  
**Version reviewed:** 1.0.0  
**Audit date:** 2026-08-05  
**Scope:** Complete first-party server, browser, worker, database, container, deployment, integration, and documentation source in the supplied archive

## Versioning note

The project owner designated this audited codebase as the first public stable release, version 1.0.0. Earlier internal version labels were development history and are not part of the public release sequence.

## Executive summary

The application was reviewed feature-by-feature rather than only by file or test name. The audit inventoried **96 declared HTTP routes**, including **93 API routes**, and cross-checked **72 unique client API paths** against the server. It also reviewed the dashboard's nine primary navigation sections, 354 static HTML IDs, labels and ARIA relationships, shared theme variables, overlays, responsive controls, worker boundaries, SQLite access, filesystem permissions, secrets handling, public endpoints, integrations, and release packaging.

After the fixes in this audit:

- No operational API route was found that is available to an unauthenticated user.
- Administrator routes require both authentication and the administrator role.
- The only intentionally unauthenticated HTTP surfaces are the minimal health/bootstrap/authentication flows, the opt-in public status page, and the HMAC-authenticated deployment webhook.
- The optional Prometheus endpoint fails closed unless both the feature and a bearer token are configured.
- Public status no longer exposes site domains, ports, logs, configuration, or other deployment metadata.
- Deployment webhooks no longer reveal whether a site or webhook configuration exists, and internal deployment failures are not returned to the caller.
- Local database, snapshot, backup, upload-temporary, and credential files are protected with owner-only permissions where the platform supports POSIX modes.
- Outbound integrations reject redirects so authorization headers and saved integration headers are not forwarded to an unexpected host.
- All **153 automated tests pass**, and every JavaScript source file included by the project syntax check parses successfully.

This is a strong source-level and automated regression result, but it is not a formal penetration test or proof that third-party infrastructure is configured safely. Live Cloudflare, Certbot, Docker, S3/SFTP/restic, OpenTelemetry, SMTP/Slack/Discord, Git provider, passkey hardware, and full browser rendering tests require real credentials and services and were not simulated with production accounts.

## Audit method

The review combined:

1. Route and middleware inventory for all Express endpoints.
2. Client-to-server endpoint reachability checks.
3. Static UI ID, selector, label, ARIA, theme-token, overflow, modal, toast, and responsive-layout checks.
4. Authentication, role, CSRF/origin, rate-limit, webhook, session, MFA, and WebAuthn review.
5. Direct SQLite schema, migration, query, transaction, index, retention, and file-permission review.
6. Secrets serialization and outbound-data-flow review.
7. Upload, archive, extraction, file-editor, snapshot, backup, plugin, update, and release path review.
8. Worker and queue lifecycle, cancellation, cleanup, and shutdown review.
9. Syntax and 153-test regression execution against the final source.
10. Clean-room release packaging checks for generated secrets, runtime databases, dependencies, traversal paths, and accidental runtime content.

## Findings fixed in this audit

### 1. Public status exposed deployment hostnames

**Risk:** Medium confidentiality issue. An administrator could intentionally enable public status but unintentionally disclose domains associated with every enabled site.

**Fix:** Public status now selects and returns only the service name and a coarse health state. Domains, ports, runtime details, logs, and configuration are excluded. The status-page tooltip and documentation now describe the remaining disclosure clearly so administrators can choose non-sensitive public names.

### 2. Deployment webhook responses allowed enumeration

**Risk:** Medium. Different errors for a missing site, disabled webhook, or invalid signature let an unauthenticated caller determine which site IDs or webhook configurations existed. Raw deployment errors could also disclose internal paths or tooling details.

**Fix:** Webhook authentication performs a timing-safe comparison against a dummy secret when the site/configuration is absent and returns the same authentication failure. Deployment errors are written to authenticated runtime logs while the webhook receives a generic error. Replay protection, rate limiting, HMAC verification, and serialization remain in place.

### 3. Unauthenticated mutation requests entered serialization queues

**Risk:** Medium availability issue. Site and plugin mutation routes eventually rejected unauthenticated users, but middleware ordering let those requests reserve queue work before rejection.

**Fix:** Authentication and administrator checks now run before site/plugin mutation serializers. Invalid webhook requests are also rejected before reserving a site mutation slot.

### 4. Credential-bearing outbound requests could follow redirects

**Risk:** Medium. A configured endpoint that redirected to another host could cause saved Cloudflare, alert, or OpenTelemetry headers to be forwarded outside the intended trust boundary.

**Fix:** Cloudflare API calls, generic alert webhooks, and OpenTelemetry exports now use `redirect: 'error'` and bounded timeouts. The documentation identifies every administrative egress boundary.

### 5. Git deployment metadata accepted local paths or embedded credentials

**Risk:** Medium-to-high confidentiality issue. A `file://` repository could expose host content through an administrative deployment mistake, and credentials embedded in a Git URL could be stored or displayed as site metadata.

**Fix:** Git repository validation accepts HTTPS, SSH, and strict `git@host:path` syntax, rejects control characters, blocks `file://`, and rejects HTTP/SSH URLs containing usernames/passwords or tokens. Credentials must be provided through an external Git credential mechanism rather than shared metadata.

### 6. Sensitive archives could inherit permissive filesystem modes

**Risk:** Medium on multi-user hosts. Backup, snapshot, and multipart temporary files can contain application code, configuration, and database content.

**Fix:** Sensitive archives and upload temporary files are created with mode `0600`; runtime storage directories use `0700`; the database, WAL, and SHM files are tightened to `0600`; failed backups remove partial local archives. These controls are best-effort on filesystems that do not implement POSIX permissions.

### 7. Database hardening and visitor-statistics indexing gaps

**Risk:** Low-to-medium. The existing database already used parameters and sensible SQLite pragmas, but global recent-statistics and IP-based retention/privacy operations lacked two useful indexes, and database file modes were not actively tightened after open.

**Fix:** Added global recent-statistics and IP indexes and owner-only database/WAL/SHM permission tightening. Existing WAL, foreign-key enforcement, busy timeout, bounded retention, and transactions remain intact.

### 8. Saved log-filter parsing and response shape were inconsistent

**Risk:** Low reliability/UX issue. Corrupt saved JSON could break the panel, and create/update/list shapes were not consistently serialized.

**Fix:** Saved filters now use defensive parsing and one consistent serializer.

### 9. Operations accessibility and contextual guidance gaps

**Risk:** Low UX/accessibility issue. Some operations tabs lacked complete tab-to-panel relationships, and several consequential settings were easy to misunderstand.

**Fix:** Added proper tab IDs, `aria-controls`, `aria-labelledby`, and tabpanel relationships. The dashboard now has **20 keyboard-focusable contextual help tips**, including public status, Prometheus, OpenTelemetry headers, visitor privacy, plugin trust, runtime isolation, outbound network, anti-bot protection, atomic releases, Git URLs, npm install, edge publishing, and firewall behavior. Documentation was expanded for uploads, security boundaries, public data, database storage, and external integrations.

## Complete feature review matrix

| Feature area | Features reviewed | Result |
|---|---|---|
| Bootstrap and registration | First-user setup, registration lock, locale/setup state, public bootstrap response | Reviewed; bootstrap exposes only setup/authentication state and the authenticated caller's public user object |
| Password authentication | Registration, login, logout, password hashing, session cookie, oversized-password rejection | Reviewed and regression-tested |
| MFA and passkeys | TOTP enrollment/login, recovery behavior, WebAuthn options/verification, challenge scoping, CBOR/base64 bounds | Reviewed and regression-tested |
| User administration | User list/create/update/delete, active state, roles, password reset paths | Administrator-only routes verified |
| Site lifecycle | Create, edit, enable, start, stop, restart, delete, status decoration | Authentication and mutation serialization verified |
| ZIP and folder uploads | Multipart storage, ZIP signature/size/path/encryption validation, folder normalization, replacement, worker lifecycle | Reviewed; worker-thread temp deletion regression fixed previously and retained |
| Static hosting | Entry file, cache controls, compression, minification, obfuscation, ETags, SPA/error behavior | Reviewed and regression-tested |
| Node.js hosting | Entry command, npm production install, health/restart policy, process cleanup, environment allowlist | Reviewed and regression-tested |
| Docker isolation | Container mode, outbound-network option, resource limits, shared networks, optional socket overlay | Source/config reviewed; live Docker execution not available |
| Edge/domain routing | Shared HTTP/HTTPS proxy, hostname routing, domain-only access, redirects, headers, WebSockets | Reviewed and regression-tested |
| TLS and Cloudflare | Certbot flow, renewal interruption behavior, DNS/WAF synchronization, trusted edge headers | Source reviewed; live provider execution not available |
| Firewall and anti-bot | Local rules, CIDRs, Cloudflare-scoped rules, Anubis sidecar compatibility | Reviewed and regression-tested; external container/provider execution not available |
| Maintenance and errors | Maintenance mode, custom error pages, redirects, custom headers | Input validation and UI reachability reviewed |
| File browser/editor | List/read/write/replace/delete, text-only checks, traversal prevention, staged critical deletion | Reviewed and regression-tested |
| Analytics | Request totals, country map, visitor privacy, cardinality/retention, statistics batching | Reviewed; indexes and bounded retention verified |
| Performance | Process/event-loop/disk metrics, per-site sampling, refresh, bounded reads | Reviewed and regression-tested |
| Alerts and logs | Runtime events, logs, search/filtering, retention, alert destinations/tests | Auth/role and secret masking reviewed; external destinations not live-tested |
| Snapshots | Create/list/restore/delete, rollback snapshot, worker extraction, owner-only archive | Reviewed and regression-tested |
| Dependency scanning | Site dependency scan and UI request lifecycle | Reviewed; live registry result depends on network access |
| Plugins | JSON/JavaScript plugins, ZIP install, signatures, settings/secrets, actions, toggle/delete, sandbox/lifecycle | Reviewed and regression-tested; JavaScript plugins remain trusted administrative code |
| Environment variables | Per-site values, secret encryption/masking, deletion, environment allowlists | Reviewed and regression-tested |
| Database profiles | Create/update/delete, encrypted connection value, response masking | Administrator-only and masking verified |
| Scheduled jobs | Five-field cron, standard day matching, timeout, overlap, enable/disable, history | Reviewed and regression-tested |
| Releases and rollback | Atomic release directories, activation validation, retention, rollback | Reviewed and regression-tested |
| Git deployments | Repository/branch validation, release creation, credentials policy | Reviewed; live provider authentication not available |
| Deployment webhooks | HMAC, timestamp/replay protection, rate limiting, queue ordering, generic failures | Reviewed and regression-tested |
| Preview deployments | Create/list/delete, process/container cleanup, failure handling | Reviewed and regression-tested |
| Config import/export | Site configuration export/import, secret omission, validation | Authenticated; secret-bearing values excluded |
| Backups | Local/S3/SFTP/restic profiles, consistent SQLite snapshot, archive permissions, history | Source reviewed; external destinations not live-tested |
| Observability | Prometheus bearer endpoint, OpenTelemetry metrics/headers, public status | Auth and disclosure behavior reviewed and hardened |
| SHAM updates | Signed archive validation, staging, persistent activation, rollback/cleanup | Reviewed and regression-tested |
| Theme and localization | Built-in/custom theme state, locale, semantic color variables, public status theme | Reviewed; all used theme variables are defined |
| Responsive UX | Navigation, cards, dialogs, action menus, tabs, toasts, switches, file inputs | Static layout regression checks pass; full device/browser visual QA remains recommended |
| Documentation/license | Built-in docs, README, upload help, trust boundaries, AGPL notice | Reviewed and expanded |

## Authentication and unauthenticated exposure

### Intentionally unauthenticated

- `GET /api/health`: returns only `{ ok: true }`.
- `GET /api/bootstrap`: returns setup/registration/authentication state, locale, and only the authenticated caller's public user data when a valid session exists.
- Registration/login/logout, TOTP login, and passkey login endpoints: rate-limited authentication flows.
- `GET /api/public/status` and `GET /status`: disabled by default and available only when explicitly enabled; expose title, generation time, service names, and coarse states.
- `POST /api/hooks/deploy/:id`: publicly reachable by necessity but requires a valid HMAC, timestamp/replay checks, and rate limiting; failures are uniform.
- Static dashboard assets and license content.

### Protected

All site content-management APIs, runtime status/logs, analytics, files, snapshots, dependencies, plugins, operations, exports, users, settings, backups, alerts, update controls, and configuration APIs require authentication. Every `/api/admin/...` route additionally requires the administrator role.

### Optional monitoring endpoint

`GET /metrics` is available only when Prometheus is enabled **and** a non-empty token has been saved. It requires an exact bearer token comparison and returns `401`, `404`, or `503` without metrics when the prerequisites are not met.

## ORM and database review

SHAM does **not** use an ORM. It uses `better-sqlite3` directly. Therefore, ORM concerns such as unsafe model mass-assignment, lazy-loading leaks, or ORM-generated joins do not apply; the relevant risks are SQL construction, transaction boundaries, migration correctness, retention, synchronization, encryption, and filesystem access.

Verified database controls:

- SQL values are bound through prepared-statement placeholders. The two dynamic SQL fragments found are structural only: a server-constructed `WHERE` clause from fixed predicates and a placeholder list whose values are still passed separately.
- `PRAGMA journal_mode = WAL`, foreign keys, and a 5-second busy timeout are enabled.
- Schema migrations and multi-row setting changes use transactions where atomicity is required.
- Secret values are encrypted before storage through the secret-store layer and are serialized as blank/configured flags rather than ciphertext or plaintext.
- Database profiles do not return encrypted connection values.
- Visitor analytics and logs have bounded retention/cardinality behavior.
- Indexes cover site/time lookups, recent global visitor statistics, and IP operations used by privacy/retention workflows.
- Database, WAL, and SHM files are tightened to owner read/write (`0600`) where supported.
- Backups use a consistent SQLite snapshot rather than copying an actively mutating database file blindly.

Residual database characteristics:

- SQLite is a single-writer database. SHAM uses short synchronous queries and transactions, but very high concurrent write volume can still cause latency despite WAL and the busy timeout.
- `better-sqlite3` is synchronous by design. Current request-path queries are bounded/indexed, while archive and transformation work is moved to workers, but unusually large deployments should still be load-tested on the intended hardware.
- Encryption protects stored application secrets, not every non-secret database column. Host/root access can read site metadata, audit logs, analytics, and other operational data; host security and encrypted disks remain important.

## Outbound data and trust-boundary review

No unauthenticated route can configure or trigger the administrator-only integration settings. However, SHAM intentionally sends data to endpoints selected by an administrator:

- **Cloudflare:** zone/domain configuration and API credentials are sent to Cloudflare's API.
- **Certbot/ACME:** domain and account/certificate data are sent to the configured ACME service.
- **Git/npm:** repository requests and package metadata/downloads go to configured providers/registries.
- **Alert destinations:** operational alert text and identifiers go to the configured email/webhook/Slack/Discord destination.
- **OpenTelemetry:** SHAM process metrics and configured headers go to the selected collector; redirects are rejected.
- **Backups:** full backup archives go to the configured local, S3, SFTP, or restic destination.

These are administrative trust decisions rather than hidden data channels. The documentation now makes them explicit. Private-network destinations remain possible by design because self-hosted collectors, Git services, backup servers, and webhooks are legitimate use cases. Treat permission to configure these endpoints as equivalent to privileged outbound-network access.

## UI, reachability, theme, and layout review

Static dashboard validation produced the following results:

- **9** primary navigation items map exactly to **9** primary section panels.
- **354** HTML IDs are unique.
- No broken `label for`, `aria-controls`, `aria-labelledby`, or `aria-describedby` targets were found.
- Every selector of the audited static `#id` form resolves to a known UI element.
- **72 unique client API paths** map to a declared server route.
- All **36** CSS custom properties used by the interface are defined.
- No inline `style` attributes are present in the main dashboard HTML, reducing theme drift and CSP conflicts.
- Modals have bounded viewport height and scrolling, action menus are viewport-bounded, toast width is responsive, action rows wrap, and operations tabs scroll horizontally on narrow screens.
- The public status page loads the same theme initialization and stylesheet as the dashboard.
- Consequential settings have **20** focusable help tips rather than relying on mouse-only hover behavior.

No statically unreachable panel or broken cross-reference was found after the fixes. This audit could not complete screenshot-based pixel comparison in a real browser because the available headless Chromium process did not run reliably in the environment. Manual checks in current Chrome, Firefox, Safari, mobile Safari, and Android Chrome are still recommended for font metrics, native form controls, focus rings, virtual keyboards, and OS-level contrast behavior.

## Performance and regression review

Verified safeguards include:

- Site and plugin mutations are serialized, but authentication now occurs before queue admission.
- Upload/extraction, snapshots, updates, plugin archives, and static transformations use workers or bounded pools rather than unbounded main-thread work.
- Worker shutdown and active child-process cleanup are covered by tests.
- Visitor analytics is batched and bounded; rate-limit maps and runtime-event/log retention are bounded.
- Per-site performance sampling avoids one database query per running site and bounds process reads.
- Client refreshes use separate request lifecycles and stale responses cannot overwrite newer views.
- File scans tolerate concurrent deletion and avoid synchronous request-path tree operations for large work.
- Network calls use timeouts; sensitive integrations reject redirects.
- Failed backups and previews clean up partial resources.

Residual performance considerations:

- Snapshot creation uses `adm-zip` in a worker and can consume memory proportional to the bounded project/upload size. Keep upload limits appropriate for available RAM and test large real projects.
- SQLite remains a single-writer store. A high-volume multi-tenant installation should be benchmarked with realistic request, log, and analytics traffic.
- Docker, npm, Git, Certbot, and external backup performance depends heavily on network and host configuration and was not load-tested here.

## Dependency security status

The application pins production dependencies exactly. The supplied source uses:

- `adm-zip` 0.6.0, replacing the vulnerable 0.5.x line.
- `multer` 2.2.0 with nested multipart fields disabled.
- `jsonwebtoken` 9.0.3 on the patched JWS dependency line.
- A Docker build step that runs the high-severity production audit and fails the build if the audit fails.

A fresh `npm audit` and lockfile-resolution verification could not be completed because the package registry was unavailable from the audit environment. The archive does not include `node_modules` or a generated lockfile. Before production deployment, run:

```bash
npm install
npm run security
npm test
```

Commit the resulting lockfile if reproducible dependency resolution is required for your deployment process.

## Validation results

```text
npm run check: PASS
npm test:      PASS
Tests:         153 passed, 0 failed, 0 skipped
First-party JS/HTML/CSS lines reviewed by automated inventory: 17,208
HTTP route declarations: 96
API route declarations: 93
Unique client API paths: 72
Unique HTML IDs: 354
Help tips: 20
CSS variables used/defined: 36 / 36
```

## Remaining trust and deployment considerations

1. **JavaScript plugins are trusted code.** Capability checks and lifecycle protections reduce accidental misuse, but installing an administrator-approved JavaScript plugin is still equivalent to running code inside the SHAM trust boundary.
2. **Process-mode hosted applications share the host boundary.** Environment allowlists reduce secret inheritance, but they do not create a kernel sandbox. Use Docker isolation or a dedicated host/VM for untrusted applications.
3. **Docker socket access is highly privileged.** The optional isolation overlay that exposes the Docker socket effectively grants host-level container control to SHAM. Run it on a dedicated machine or VM and restrict access to the dashboard.
4. **Public status is an opt-in disclosure.** It is minimized, but public service names and coarse health states remain public by design.
5. **Prometheus is bearer-token protected, not network-isolated.** Use TLS and network controls in addition to the token.
6. **Backups contain sensitive data.** Protect destination credentials, retention, encryption, and access controls independently of SHAM.
7. **Host compromise supersedes application controls.** Disk encryption, OS patching, least-privilege service users, firewalling, and secure reverse-proxy/TLS configuration remain required.
8. **Manual browser and live integration QA remains necessary.** Source and regression tests cannot fully validate provider behavior, real certificate issuance, real passkeys, external backup restoration, or every browser's visual rendering.

## Conclusion

The completed audit did not find an unauthenticated operational API or an unintended public data channel after the applied fixes. The server-side role boundaries, direct SQLite access, secrets serializers, archive permissions, queue ordering, outbound redirect behavior, public status, webhook handling, and UI reachability now have explicit regression coverage. The final result is suitable for controlled deployment testing, subject to a successful fresh dependency audit, live integration tests with the intended infrastructure, and normal host-level hardening.
