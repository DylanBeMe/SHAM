# Getting started

## Requirements

- Node.js 22 or newer.
- npm.
- SQLite support through `better-sqlite3`.
- Docker only when you use OCI images, Dockerfile builds, Buildpacks/Nixpacks container output, Docker Compose, or Docker-isolated legacy Node.
- Certbot only when SHAM is responsible for certificate issuance.
- `git` for Git-backed deployments.

## Install

```bash
cp .env.example .env
npm ci
npm start
```

The default dashboard listens on `127.0.0.1:8080`. Complete the first-user flow to create the initial administrator.

For production, put the dashboard behind HTTPS, run SHAM as an unprivileged operating-system account, persist `SHAM_DATA_PATH`, and keep the data directory out of the source tree.

## Persistent data

`SHAM_DATA_PATH` contains the database, site data, releases, backups, encrypted settings, generated key material, and runtime metadata. Treat it as private state.

Do not commit the runtime data directory. In particular, a generated `data/.jwt-secret` is instance state, not source code. CI should run:

```bash
npm run release:check
```

before packaging or publishing.

## Create a site

The site wizard supports four source paths:

1. **Upload** — upload files or an entire folder.
2. **Git repository** — clone and deploy from a supported Git provider or a repository URL.
3. **Docker image** — run an existing OCI image without overlaying uploaded source onto the image.
4. **Reverse proxy** — route SHAM traffic to an existing upstream service.

The selected runtime determines how the source is executed. See [Runtimes and Docker](runtimes-and-docker.md).

### Folder uploads

SHAM accepts large folder trees using disk-backed multipart storage and a bounded field/file count. The site form deliberately allows enough non-file fields for the complete runtime configuration while keeping an upper bound on multipart parsing.

If a folder has a single enclosing directory, SHAM strips that common directory before installation.

## Deployment flow

Git deployments use immutable release directories:

1. Clone into a staging area.
2. Read and validate any `sham.yaml`, `sham.yml`, or `sham.json`.
3. Run configured install/build steps.
4. Move the candidate to its final immutable release path.
5. Start the candidate.
6. Wait for readiness.
7. Switch SHAM traffic to the candidate.
8. Drain and stop the old backend.
9. Persist the active release.

If candidate startup or readiness fails, the existing release remains active.

## Navigation

The left navigation includes Dashboard, Sites, Observability, Performance, Security, Extensions, and administrator Settings. The four attention cards at the top of Dashboard are interactive drilldowns.

Use `Ctrl/Cmd+K` for the command palette. It searches settings categories, sites, site files/logs/settings, performance, documentation, and common deployment/runtime actions.

## Updates

Use the built-in update workflow only with trusted signed update artifacts. Back up the instance first. SHAM stores application-update runtime state beneath the configured data path so a container recreation does not discard the active update metadata.
