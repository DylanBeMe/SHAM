# Runtimes and Docker

SHAM models execution with reusable runtime drivers instead of adding a new orchestration branch for every language.

## Runtime drivers

### Static

Serves a directory and entry document directly through SHAM. Useful for HTML/CSS/JS, Vite/Astro/Hugo output, and other generated static sites.

### Process

Runs a managed host process with a command/argument vector, working directory, injected host/port values, restart policy, health checks, limits, and graceful shutdown.

Built-in presets include:

- Node
- npm start
- Bun
- Deno
- FastAPI/Uvicorn
- Django/Gunicorn
- Go binary
- Java JAR
- Custom process

Process applications should bind to the injected `HOST` and `PORT`. Presets use SHAM's loopback host so an internal application port is not accidentally exposed around SHAM's managed listener.

### Container

Runs an OCI container. Container modes include:

- **Existing image** — pull/use an image such as `ghcr.io/example/app:1.4.0`.
- **Dockerfile** — build an image from the release source.
- **Buildpacks** — use Cloud Native Buildpacks when `pack` is installed.
- **Nixpacks** — build through Nixpacks when the executable is installed.

SHAM assigns and discovers internal ports, applies runtime limits, injects environment safely, waits for readiness, and removes SHAM-built transient images when they are no longer needed.

### Docker Compose

Runs a selected application service from a Compose project. Auxiliary services remain on the project network.

SHAM intentionally rejects Compose features that escape the managed project boundary, including privileged containers, host networking/PID/IPC, added capabilities, devices, Docker-socket mounts, host bind mounts, host-gateway mappings, disabled security profiles, privileged build entitlements, externally managed networks/volumes/configs/secrets, and unmanaged host-port publication.

The selected application service may publish its configured container port only to loopback. If it does not publish a port and SHAM runs on the host, SHAM adds a loopback-only ephemeral publication. If SHAM itself runs in Docker, it connects the selected service to the configured SHAM Docker network and addresses it through a managed alias.

When **outbound networking is disabled**, SHAM adds internal Compose network overrides.

### Proxy

Routes a SHAM-managed listener/domain to an already-running HTTP/S upstream. Use this when another supervisor owns the application lifecycle.

## Existing Docker images

Choose **Docker image** as the site source, then provide a valid OCI image reference and container port. SHAM does not mount an empty site directory over the application image.

Docker's normal pull-if-missing behavior applies. Pin production images to immutable tags or digests where possible.

## Dockerfiles

For Dockerfile mode:

- Build context must stay inside the deployed release.
- A relative Dockerfile path is resolved against that build context and must also stay inside the release.
- Avoid baking secrets into image layers.
- Expose/listen on the configured application port.
- Add an application health endpoint and configure HTTP readiness when possible.

Example:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0
CMD ["node", "server.js"]
```

The container itself can listen on all container interfaces; SHAM controls host publication/routing.

## Docker Compose example

```yaml
services:
  app:
    build: .
    environment:
      PORT: "3000"
    expose:
      - "3000"
    depends_on:
      - db

  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data

volumes:
  db-data:
```

Select service `app` and container port `3000` in SHAM. Do not publish the database to the host.

## Readiness, liveness, and shutdown

Readiness controls whether a candidate may receive production traffic. Supported probe styles include HTTP, TCP, command, and disabled/none where appropriate.

Prefer an HTTP readiness endpoint that confirms dependencies needed to serve traffic are usable.

Liveness runs after activation and can trigger the configured restart policy. Startup timeout, probe path/status range, interval, shutdown grace, and blue/green drain are configurable.

## `sham.yaml`

A repository can describe its build/runtime policy:

```yaml
build:
  command: npm ci && npm run build

runtime:
  driver: process
  command: ["npm", "run", "start"]
  portEnv: PORT

health:
  type: http
  path: /health
  startupTimeout: 45
```

SHAM hashes execution-relevant policy. A Git commit that changes repository-controlled execution policy requires explicit approval before deployment. Review manifest diffs as code execution changes, not ordinary metadata changes.

## Docker-host mapping when SHAM is containerized

When SHAM itself runs in Docker and asks the host Docker daemon to mount staged paths, configure `SHAM_DOCKER_HOST_DATA_PATH` to the host-side path corresponding to SHAM's data volume.

Configure the managed Docker network settings described in `.env.example` for container/Compose communication.

## Reliability guidance

- Prefer immutable image tags/digests.
- Use readiness probes.
- Keep application state outside ephemeral runtime containers.
- Use named Compose volumes rather than host bind mounts.
- Keep databases/private services un-published.
- Set CPU, memory, PID, and connection limits appropriate to the application.
- Review Dockerfile/Compose changes like infrastructure code.
