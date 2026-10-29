# rxlocal-mcp

MCP server for the **RxLocal** pharmacy patient portal (`patient.rxlocal.com`,
PioneerRx / RedSail Technologies). It reads the account holder's profile and a
few account-level details through the user's **signed-in browser tab**, reusing
their authenticated session via the fetchproxy bridge.

This project was developed and is maintained by AI. Use at your own discretion.

## What it can read

| Tool | Returns |
|---|---|
| `rxlocal_profile` | Account holder's name, email, phone, account type, patient + user IDs |
| `rxlocal_age_gate` | Whether the account holder is under the portal's minimum age |
| `rxlocal_notifications` | The portal's most-relevant notification banner state |
| `rxlocal_legal` | The Terms of Use or Privacy Policy document |
| `rxlocal_healthcheck` | Whether the session and API are working |

### Scope limitation

Prescriptions, refills, and pharmacy messages are **not** exposed. RxLocal binds
those endpoints to the live single-page-app session, and they reject any request
replayed outside it (they return 401 even with a freshly captured live token).
This server exposes only the stateless account reads that work server-side.

## Setup

No credential is configured in the environment — the server reads the short-lived
Keycloak token from the signed-in tab via the **ContextMint Bridge** browser
extension. Install the extension, sign in to `patient.rxlocal.com`, keep that tab
open, and approve the one-time pair code the first tool call prints.

```jsonc
// .mcp.json
{ "mcpServers": { "rxlocal": { "command": "npx", "args": ["-y", "rxlocal-mcp"] } } }
```

## Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `RXLOCAL_DISABLE_FETCHPROXY` | Set to `1` to refuse the browser-bridge read (CI/headless). Every tool then fails, since there is no other credential path. |
| `FETCHPROXY_WS_PORT` | Localhost port of the fetchproxy concentrator the extension connects to (default `37149`). Shared by every MCP on the machine. |
| `FETCHPROXY_WS_HOST` | Bind interface for the concentrator, a literal IP (default `127.0.0.1`). |
| `FETCHPROXY_IDENTITY_DIR` | Where the fetchproxy identity keypair is stored (default `~/.fetchproxy/identity/`). |

## Shell-only alternative

A lightweight `fpx` skill covering the same two reachable reads (profile, age)
ships under `skills/rxlocal-fpx/` — no MCP process required.

## Development

```sh
npm install
npm run build
npm test        # typecheck + vitest, fully mocked, no network
```
