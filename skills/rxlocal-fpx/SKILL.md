---
name: rxlocal-fpx
description: "Read an RxLocal pharmacy patient portal (patient.rxlocal.com, PioneerRx/RedSail) from a shell: your account profile and the account-holder age gate, through your signed-in portal tab with the fpx CLI. NOTE: prescriptions/refills and pharmacy messages are NOT reachable (the portal binds them to the live SPA session; they 401 on replay). Use when asked about an RxLocal / PioneerRx pharmacy portal account."
---

# RxLocal patient portal access (fpx)

RxLocal Patient (PioneerRx / RedSail Technologies) is a single-page app at
`https://patient.rxlocal.com`. There is no public API. Its own `/api/*` backend
is a Keycloak-protected Bearer API: the SPA holds a short-lived access token and
sends it as `Authorization: Bearer …` plus an `rxlocaluserid` header. So every
call here reads the live token from the signed-in tab and routes the request
through that tab with `fpx`. Read-only.

## What works, and what doesn't

- **Account reads work** (`profile`, `age`): stateless endpoints that accept the
  bearer from `localStorage.kc_authRes.accessToken`.
- **Patient-data reads are NOT reachable** (`refills`, `messages`, `patient`).
  Tested 2026-10-28, all return **401**: with the persisted token, with a
  freshly fpx-captured live token, and via an in-page fetch (page origin +
  cookies). The portal binds these endpoints to the SPA's own request pipeline
  (its axios interceptor's just-in-time token handling plus a server-side
  session), which a shell replay cannot reproduce. The commands exist and fail
  cleanly with exit 4; reaching this data would require the request to be issued
  by the SPA itself, which is out of scope for a shell skill.

Keep the signed-in `patient.rxlocal.com` tab open so the account token stays
fresh. reCAPTCHA v3 guards login only, not the API.
## One-time setup

```sh
npm install -g @fetchproxy/cli                  # provides `fpx`
fpx profile add rxlocal --domain rxlocal.com
# declare ALL scopes BEFORE the first pairing (a later declare forces a re-pair):
fpx profile declare rxlocal \
  --local-storage kc_authRes \
  --capture-header authorization@patient.rxlocal.com \
  --capture-header rxlocaluserid@patient.rxlocal.com
```

Needs **ContextMint Bridge** in the browser that holds the portal session, with a
`patient.rxlocal.com` tab open and signed in. The first call prints a pair code
on stderr; approve it in the bridge popup **of that browser**. If the bridge also
runs in a second browser, every call prints `refusing an extension whose identity
is not the one this MCP paired with` and a fresh pair code — that is the other
browser being turned away, the call still succeeds, and those codes should NOT be
approved. Wrong browser pinned? `fpx trust clear fpx-rxlocal`, then pair again.

## Core call

```sh
R=~/.claude/skills/rxlocal-fpx/scripts/rxlocal
$R profile          # name, email, phone, account type, patient + user IDs
$R age              # account-holder age gate
$R patient          # demographics for the active patient
$R refills          # prescriptions / refills on file (the med list)
$R messages         # recent messages with the pharmacy
$R notifications    # most-relevant notification banner
$R raw GET  <path>              # any /api path, unprojected
$R raw POST <path> '<json>'     # any /api POST, unprojected
```

`<path>` is everything after `/api/` (e.g. `account/getuserinfo`). stdout is
JSON ready for `jq`; stderr carries pair codes and status.

## Exit codes (from fpx)

`0` ok · `2` bridge down (open/reload the signed-in tab) · `3` bot wall ·
`4` upstream HTTP error (often a 401 — the token aged; reload the tab).

## Rules

- **Read-only.** No write verbs are wired. The portal can send messages and
  request refills; this skill does not.
- **The token is the user's own credential.** The helper reads it from the tab
  into a variable and passes it as a request header for that one call. Do not
  print the token, and do not write it to disk.
- Request/response shapes were verified live on 2026-10-28 from the signed-in
  tab. Endpoint catalog: `references/endpoints.md`. jq recipes:
  `references/recipes.md`.
