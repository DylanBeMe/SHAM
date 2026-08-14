# Getting started

This guide gets a new SHAM instance from source to its first deployed site. For production hardening, continue with [Operations and security](operations-and-security.md) and [Configuration reference](configuration-reference.md).

## 1. Requirements

Base dashboard:

- Node.js 22 or newer.
- npm.
- SQLite support through `better-sqlite3`.

Install optional tools only for features you plan to use:

- `git` — Git deployments.
- Docker — existing OCI images, Dockerfile builds, Docker Compose, Docker-isolated Node/runtime execution, and Anubis.
- Certbot — certificate issuance/renewal.
- `pack` — Cloud Native Buildpacks.
- `nixpacks` — Nixpacks builds.
- Restic/AWS CLI/SFTP — corresponding backup destinations.

## 2. Install

```bash
cp .env.example .env
npm ci
npm start
```

The dashboard listens on `127.0.0.1:8080` by default.

The first successfully created account becomes the administrator. SHAM then locks ordinary public registration unless the administrator explicitly changes the registration policy.

## 3. Production basics before exposing the dashboard

At minimum:

1. Put the dashboard behind HTTPS.
2. Persist `SHAM_DATA_PATH` outside the source tree.
3. Supply a strong `SHAM_JWT_SECRET` through a secret store/environment.
4. Run SHAM as an unprivileged OS user.
5. Configure proxy trust narrowly.
6. Mount the Docker socket only if Docker-managed application features are required.
7. Keep independent backups of the complete SHAM data path.

See [Configuration reference](configuration-reference.md) for environment settings.

## 4. Understand persistent data

`SHAM_DATA_PATH` contains private mutable instance state, including:

- SQLite state.
- Site content.
- Immutable releases/previews.
- Generated JWT/master-key material when not supplied externally.
- Plugin packages/settings.
- Certificates.
- Backups and update state.
- Runtime metadata.

Do not commit this directory. A generated `data/.jwt-secret` is instance state, not source code.

Before distributing source, run:

```bash
npm run release:check
```

## 5. Create a site

The wizard offers four primary source choices.

### Upload

Upload a normal ZIP or select a folder from the browser. Use this for static sites or source trees you want SHAM to run directly.

SHAM strips one common enclosing directory. For example, a selected folder containing `my-site/index.html` is installed with `index.html` at the site root.

The multipart form is bounded, but the current field-count allowance includes the expanded runtime/site configuration. Older builds could report `Upload rejected: Too many fields`; see [Troubleshooting](troubleshooting.md) if you encounter that message.

### Git repository

Choose a connected Git provider or paste a direct HTTPS/SSH Git URL. Supported connected providers are GitHub, GitLab, Bitbucket Cloud, Gitea, and Forgejo.

Git sites support install/build commands, immutable releases, previews, webhooks, and repository manifests. See [Git and CI/CD](git-and-cicd.md).

### Docker image

Supply an existing OCI image and the container port the application listens on. SHAM preserves the image filesystem; it does not mount an empty uploaded project over the application image.

See [Runtimes and Docker](runtimes-and-docker.md).

### Reverse proxy

Use this when the application lifecycle is managed outside SHAM. Configure the upstream host/port and let SHAM provide the public listener/domain/policy layer.

## 6. Choose a runtime

SHAM has five runtime drivers:

- **Static** — serve files directly.
- **Process** — execute a managed host process.
- **Container** — run an OCI container from an image or source-to-image build.
- **Compose** — run a constrained Docker Compose application.
- **Proxy** — route to an external upstream.

Process presets currently include Node, npm, Bun, Deno, FastAPI, Django, Go, Java, and Custom.

Container presets include Existing image, Dockerfile, Buildpacks, and Nixpacks.

## 7. Make server applications listen correctly

Managed application servers should bind the `HOST`/port value SHAM injects.

Example Node/Express:

```js
const express = require('express');
const app = express();

app.get('/health', (_req, res) => res.sendStatus(204));
app.get('/', (_req, res) => res.send('Hello'));

app.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
```

For framework-specific presets, use the generated/default command as a starting point and adjust module names/paths for your application.

## 8. Configure readiness

A process opening a socket does not always mean the application is ready to serve production traffic.

Prefer an HTTP readiness endpoint that confirms the application has completed critical initialization. SHAM supports TCP, HTTP, command, and disabled readiness types where appropriate.

Git/release activation follows this general flow:

1. Clone/build into staging.
2. Read/validate repository manifest.
3. Move candidate to its final immutable release path.
4. Start candidate runtime.
5. Wait for readiness.
6. Switch traffic to the candidate.
7. Drain the previous backend.
8. Stop previous backend.
9. Persist active release metadata.

A candidate that fails before traffic switching does not replace the existing backend.

## 9. Learn the dashboard

The left navigation includes Dashboard, Sites, Observability, Performance, Security, Extensions, and Settings.

The four Dashboard attention cards are interactive drilldowns for:

- Unhealthy sites.
- Recent failed deployments.
- Active alerts.
- Automated traffic.

Press **Ctrl/Cmd+K** to search settings, websites, site files/logs/settings, performance, documentation, and common runtime/deployment actions.

See [Dashboard and UI](dashboard-and-ui.md).

## 10. Optional next steps

- Connect a Git provider and enable signed/provider webhooks.
- Add HTTP readiness/liveness probes.
- Configure environment variables and secrets.
- Configure backups and test a restore.
- Enable OIDC/passkeys/TOTP according to your identity model.
- Configure Cloudflare/Certbot/Tunnels if needed.
- Create a scoped API token for CI/CD.
- Try the administrator Plugin playground before packaging a plugin.

## Updating SHAM

The in-app update workflow is for reviewed SHAM update archives and persists application releases beneath `SHAM_DATA_PATH`. Updates that change runtime dependencies require a reviewed image/manual upgrade rather than silently installing new server dependencies.

The managed update payload includes the application source, dashboard assets, `docs/`, and the bundled CLI so documentation and automation tooling stay aligned with the active release.
