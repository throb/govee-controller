# Security

Light Bridge is a trusted-user, local desktop service. It is not an authenticated multi-user service. Do not publish port 8765 through a tunnel, proxy, or LAN bind.

## Boundaries

- HTTP binds to 127.0.0.1 and checks Host, Origin, and cross-site Fetch Metadata.
- Mutations require the current server-instance token. MCP also checks the installation identity; this prevents accidental cross-install writes, not access by other trusted local processes.
- Responses disable MIME sniffing and framing and suppress referrer information.
- Static files use an explicit allowlist. Source, data, credentials, and Git files are not served.
- Govee credentials use Windows user-bound DPAPI. They are sent only to the configured official HTTPS Govee API; redirects are rejected. The UI clears its key input after connection attempts.
- Status and MCP tools do not expose the API key. Request logging is disabled.
- data/, environment files, private-key files, logs, caches, and local verification reports are excluded from Git.
- MCP clients can explicitly start physical lights. Only connect trusted agents. Local processes running as your user can access this service and decrypt user-bound credentials.
- UDP device traffic is unauthenticated. Use a trusted LAN. Discovery is not proof of device identity.

## Before publishing

Run the tests, inspect git diff --cached, confirm git ls-files contains no data/ or credentials, and scan staged content for the actual saved credential without printing it. Screenshots must not show Settings credentials, device identifiers, or network addresses.

Report suspected credential exposure privately to the repository owner; never attach a real key to a public issue. Rotate any exposed key with its provider.
