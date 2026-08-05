# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| Older internal builds | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.
4. Include affected versions, reproduction steps, impact, and any proposed mitigation.

Please avoid accessing data that is not yours, disrupting running systems, or publishing details before a fix is available. Maintainers should acknowledge a complete report promptly, keep the reporter informed, and coordinate disclosure after a patched release is available.

## Security expectations for deployments

SHAM executes administrator-supplied Node.js applications and enabled JavaScript plugins as trusted code. Use a dedicated host or VM, run SHAM unprivileged, restrict mounted data and network access, protect the dashboard, and prefer Docker isolation for code that is not fully trusted. See the README's trust-boundary and security sections.
