# Plugin development

SHAM supports declarative JSON plugins and JavaScript plugins. Plugins can extend dashboard UI and, when explicitly permitted, server-side actions.

## Start with the playground

Open **Extensions → Plugin playground**.

The playground lets you:

- Edit/validate `plugin.json` with SHAM's real manifest validator.
- Add optional browser `client.js`.
- Preview UI registration in a sandboxed iframe.
- Inspect the normalized manifest returned by the server.

The playground manifest payload is limited to 128 KiB.

The preview iframe has no same-origin access and blocks network requests through its CSP. It runs with `sandbox="allow-scripts"`.

**Server plugin code is never executed in the playground.** This is intentional; a browser playground is not a safe server-code sandbox.

## Minimal manifest

A plugin archive contains `plugin.json`.

Conceptual example:

```json
{
  "id": "example-status",
  "name": "Example status",
  "version": "1.0.0",
  "type": "json",
  "permissions": [],
  "ui": {
    "dashboardCards": [
      {
        "id": "example-card",
        "title": "Example"
      }
    ]
  }
}
```

Use the playground's default manifest as the authoritative starting shape for the current SHAM version.

## Browser client

A plugin may expose `client.js` and register through the SHAM browser plugin API.

The production plugin API can expose helpers according to plugin permissions/context. The playground uses stubbed helpers and intentionally does not provide real server/network access.

Do not assume a playground stub means a capability is permitted in production.

## Server actions

JavaScript plugins can declare server actions. SHAM applies:

- Explicit permissions.
- Action timeouts.
- Bounded pending work.
- Lifecycle tracking during shutdown.
- Optional worker isolation.

Worker isolation protects the SHAM event loop from some crashes/blocks, but worker threads share the same OS process/security boundary. Do not run hostile code.

## Permissions

Request only capabilities the plugin needs. Data-related permissions are inferred/validated against declared actions for JSON plugins, and runtime APIs enforce plugin permissions.

Users should be able to review a plugin's requested permissions before installation.

## Packaging

Create a ZIP with `plugin.json` at the expected archive root plus any declared client/server files.

Avoid:

- Nested archive-root surprises.
- Generated dependencies that are not required.
- Secrets/config credentials.
- Writable host-path assumptions.
- Network access unless the plugin explicitly needs and declares it.

## Signing

SHAM supports signed plugin verification and trusted signing keys. Sign distributable plugins where possible. Unsigned plugin installation requires explicit administrator acknowledgement.

## Development loop

1. Design the manifest in Plugin playground.
2. Validate until SHAM accepts it.
3. Preview browser UI with a small `client.js`.
4. Build server actions outside the playground.
5. Add permissions deliberately.
6. Package the ZIP.
7. Install only on a development SHAM instance first.
8. Exercise shutdown/reload/error cases.
9. Sign the final artifact.
10. Test against `npm run release:check` if developing inside the SHAM source tree.

## Debugging

Use runtime/plugin logs and the browser console. Keep client scripts asynchronous and avoid expensive synchronous work on dashboard load.

When a plugin UI renders floating help, dialogs, or notifications, prefer SHAM's UI helpers so top-layer/z-index behavior remains consistent with dashboard modals.
