# Security Policy

FLL Match Manager runs on event-venue networks where anyone on the Wi-Fi can reach the server, so we take
crashes, PIN bypasses, and injection bugs seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (or open <https://github.com/JKippy/FLL-Match-Manager/security/advisories/new>).
3. Describe the issue, the affected version, and steps to reproduce.

Do not include real event PINs in reports. We aim to acknowledge reports within a few days and will
credit reporters in the published advisory unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Please upgrade before an event.

## Deployment advice

- Always start the server with a PIN (`--pin`) and choose a non-obvious one for each event.
- Run it only on a trusted event LAN; do not expose it to the internet.
