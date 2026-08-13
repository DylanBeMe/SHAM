# Troubleshooting

## Folder upload: `Upload rejected: Too many fields`

Older SHAM builds capped the site multipart form below the number of configuration fields emitted by the expanded runtime wizard. The current build uses a dedicated bounded `SITE_FORM_FIELD_LIMIT` with headroom for the complete site form.

If the error persists after upgrading, verify that your reverse proxy is not imposing its own multipart/form limits.

## Upload rejected for too many files or size

SHAM intentionally limits file count, field count, field-name size, individual/aggregate upload size, and disk-backed staging. Split exceptionally large content trees or deploy them through Git/container images instead.

## Process starts but never becomes ready

Check:

- Application binds the injected `HOST`/`PORT`.
- Readiness path is correct.
- Expected HTTP status range is correct.
- Startup timeout is long enough.
- Database/dependency initialization completes.
- Runtime logs show a listening message or error.

Do not bind host-process presets to `0.0.0.0` unless you intentionally want to bypass SHAM's internal-listener boundary.

## Docker image fails

Check:

```bash
docker image inspect IMAGE
docker pull IMAGE
```

Then verify container port, environment, architecture, and readiness path.

Existing-image mode does not mount site source over the image.

## Dockerfile build fails

Check that:

- Build context is inside the release.
- Dockerfile path is inside its build context/release.
- Docker can reach required package registries.
- The final image contains the command/application, not only a builder stage.
- Runtime port matches SHAM configuration.

## Compose rejected

SHAM rejects unsafe/unmanaged Compose features by design. Remove:

- Host bind mounts.
- Privileged mode.
- Host namespaces/network.
- Added capabilities/devices.
- Docker socket mounts.
- External networks/volumes/configs/secrets.
- Host-gateway mappings.
- Published ports on auxiliary services.

Use named volumes and private project networks.

## Compose app is reachable on host unexpectedly

Only the selected app service may expose the configured app port, and only to loopback. Auxiliary services should not have `ports:`. Use `expose:` for documentation/service-to-service intent without host publication.

## Git repository is not discovered

Check the provider connection token and base URL. For Gitea/Forgejo, ensure the configured base URL matches the repository origin/path. SHAM avoids guessing when multiple provider connections would match ambiguously.

## Webhook does not deploy

Check webhook base URL, provider permissions, signature secret, branch, and delivery ID. Review deployment/runtime logs. Replayed delivery IDs are ignored for 14 days.

## Manifest approval required

A changed `sham.yaml`/`sham.yml`/`sham.json` altered execution policy. Review the manifest and deploy with explicit approval only if the change is trusted.

CLI:

```bash
sham deploy SITE_ID --approve-manifest
```

## Restore fails before restart

A restore is rejected if archive structure, entry types, path safety, SQLite integrity, or core database tables fail validation. This is intentional; live data remains in place until staging validates.

## License button fails

The UI opens `/LICENSE`, which is served directly from the repository's `LICENSE` file. Verify the installed source package includes `LICENSE` and that a reverse proxy is not intercepting that path.

## UI popup appears behind a modal

Current SHAM attaches tooltips/toast regions to the active top-layer dialog/popover when necessary and uses a dedicated high stacking layer. Clear stale browser assets/cache after upgrading if old CSS/JS remains loaded.

## CI fails: generated JWT secret

Do not commit or package `data/.jwt-secret`. Tests that import configuration must provide a test JWT secret so they do not mutate the source tree.

Run:

```bash
npm run release:check
git status --short
```

The release check must complete without generating credentials.

## CLI hangs on unreachable dashboard

The bundled CLI applies a 30-second timeout to ordinary/control calls, with longer bounded timeouts for deploy and rollback. Verify `SHAM_URL`, DNS/TLS, and reverse-proxy connectivity if a request times out.

## More diagnostics

- **Observability**: audit/runtime events and logs.
- **Performance**: CPU/memory/latency/queue/connection data.
- **Dashboard quick views**: unhealthy sites, recent failed deployments, active alerts, automated traffic.
- **Site workspace**: release history, runtime logs, files, networking, security, and settings.
