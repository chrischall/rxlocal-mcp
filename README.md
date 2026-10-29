# rxlocal-mcp

MCP server for the **RxLocal** pharmacy patient portal (`patient.rxlocal.com`,
PioneerRx / RedSail Technologies). It reads your prescriptions, refill options
and pharmacy messages, and can request refills and message the pharmacy behind a
confirm gate, through your **signed-in browser tab**, reusing your authenticated
session via the fetchproxy bridge.

This project was developed and is maintained by AI. Use at your own discretion.

## What it can read

| Tool | Returns |
|---|---|
| `rxlocal_list_prescriptions` | Prescriptions on file: drug, Rx number, rxID, pharmacy, last fill, refills remaining, days supply, expiration, prescriber, and whether a refill can be requested now (`canRequestRefill`) or needs a renewal (`requiresRenewal`). `view: full` adds NDC, imprint and ids; `view: raw` is the whole response. |
| `rxlocal_get_refill_options` | What a refill request can choose at a pharmacy location: pickup / delivery / mail, pickup times, the pickup calendar, the pharmacy's address, phone and hours, and its refill disclaimers. Your own addresses and phone are only in `view: full`/`raw`. |
| `rxlocal_list_messages` | Recent secure messages with the pharmacy, newest first. Never marks anything read; recipient email/phone are always removed. |
| `rxlocal_profile` | Account holder's name, email, phone, account type, patient + user IDs |
| `rxlocal_age_gate` | Whether the account holder is under the portal's minimum age |
| `rxlocal_notifications` | The portal's most-relevant notification banner state |
| `rxlocal_legal` | The Terms of Use or Privacy Policy document |
| `rxlocal_healthcheck` | Whether the session and API are working |

Pharmacy-written text (message bodies, refill disclaimers) comes back inside an
untrusted-content envelope: it is data, never instructions.

### How it reaches your data

The bridge reads two things from your signed-in tab: the short-lived bearer the
web app holds, and the tab's `session-id` cookie. The server then calls the API
itself, adding the portal's public `portalid` header (the web app's
`patientPortalID` constant, sent on every request). Prescriptions and messages
need all three; without the header or the cookie they answer 401. Earlier
versions sent neither and concluded the data was unreachable; it is not
(verified live, read-only, 2026-10-29).

The server reuses the tab's session and never opens one of its own: the portal
keeps one session per user, and starting a new one signs your browser out.
After a 401 it re-reads the tab on the next call, so reloading the tab is
enough.

## Writes

| Tool | Does |
|---|---|
| `rxlocal_request_refill` | Requests a refill, or a prescriber renewal for a prescription that needs one, of one or more of your prescriptions. You choose pickup, delivery or mail and, for pickup, a time and date. It is checked against the live refill list (each must show `canRequestRefill`) and that location's options and pickup calendar before the preview. All prescriptions in one request must be yours and at one location. |
| `rxlocal_send_message` | Sends a plain-text secure message to your primary pharmacy location. No attachments. |

**UNVERIFIED on the wire.** Both sends are derived from the RxLocal web app's
JavaScript bundle (`POST refill/<groupOwnerID>/v1` and
`POST Messaging/CreatePatientMessage`). Neither has been sent to the live portal
yet. An owner-supervised live test will confirm them later. Until then, check
the result with `rxlocal_list_prescriptions` (`refillRequestStatus`) or
`rxlocal_list_messages`.

Each write is sent **once**. It is never retried on a 429, and a 401 fails
without re-reading the token or replaying the request. If a write was sent but
the answer was a 5xx, a timeout or a dropped connection, the tool reports
`status: "unknown"`. That means it may already have gone through, so check
before trying again.

### Confirm gate

Every write is gated by `@chrischall/mcp-utils`' `confirmWrite`, through its
`defineWrite` / `registerWrite`. The first call reads the portal to validate,
sends nothing, and returns a **preview + a `confirmToken`**. Only a second call
carrying that token sends, and only after you approve the preview. The exact
request body and the shown preview are bound into the token, so an argument or
portal state that changed since the preview is refused as `DRAFT_CHANGED`.
`MCP_CONFIRM_MODE` / `MCP_CONFIRM_ELICITATION` tune this (see the env table).

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
| `MCP_CONFIRM_MODE` | Confirm-gate mode for every write (default `ask-user`). `ask-user` = preview + `confirmToken` round-trip; `auto` lets a capable host confirm in one step; an unrecognised value fails closed (`refuse`). |
| `MCP_CONFIRM_ELICITATION` | `on` (default) lets the host confirm a write interactively; `off` forces the `confirmToken` round-trip. |

## Shell-only alternative

A lightweight `fpx` skill ships under `skills/rxlocal-fpx/`, with no MCP process
required. It covers the reads: profile, age gate, prescriptions, refill options,
messages and notifications. It sends nothing.

## Development

```sh
npm install
npm run build
npm test        # typecheck + vitest, fully mocked, no network
```
