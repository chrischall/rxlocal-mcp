# RxLocal `/api` endpoint catalog

Base: `https://patient.rxlocal.com/api`. Auth: `Authorization: Bearer <token>`
(from `localStorage.kc_authRes.accessToken`) + `rxlocaluserid: <globalUserID>`.
`groupOwnerID` == the account holder's own `rxLocalPatientID`. All verified live
2026-10-28 from the signed-in tab unless marked otherwise.

## Auth / token mechanics
- Token: Keycloak OIDC, realm `rxlocal`, client `patient-portal` (web),
  `aud: account`. **300-second lifespan**, refreshed by the SPA (threshold 90 s).
- On load the SPA also does `PUT /api/auth/session` and
  `PUT /api/account/token/user?forceUpdate=true` (token exchange). Patient-data
  endpoints reject a token that has aged much past mint; account endpoints don't.
- reCAPTCHA v3 guards login/registration only, NOT the API.

## Account (lenient auth — tolerate an older token)
| Method | Path | Returns (keys) |
|---|---|---|
| GET | `account/check` | 200 |
| GET | `account/getuserinfo` | `globalUserID, userName, firstName, lastName, emailAddress, smsPhone, accountType, rxLocalPatientID, primaryPersonID, primaryDataExchangeIdentifier, roles, entityStatus, passwordExpired, termsAcceptanceRequired, smsTermsAcceptanceRequired, isTestUser, isDemoUser` |
| GET | `account/accountholderage` | `underMinimumAge, minimumAge` |
| PUT | `auth/session` | 200 (session touch) |
| PUT | `account/token/user?forceUpdate=true` | token exchange |

## Patient data (strict auth — needs a fresh token)
| Method | Path | Notes |
|---|---|---|
| GET | `patients/{rxLocalPatientID}` | patient record (SPA loads this on home) |
| GET | `patients/{rxLocalPatientID}/patient` | demographics: `patientID, firstName, lastName, bornOn, smsPhone, email, dataExchangeIdentifier, globalUserID` |
| GET | `refill/{rxLocalPatientID}/v2` | **prescriptions / refills list** — the home med list. Returns 200; row shape NOT yet field-mapped (capture with `raw GET refill/{id}/v2` once paired, then project). |
| GET | `pharmacy/{pharmacyId}/hours/v2` | pharmacy hours (pharmacyId from patient/pharmacies) |
| GET | `patients/GetPatientPharmacies?GroupOwnerID={id}&RxLocalPatientId={id}` | pharmacies for the patient |
| GET | `patient/group/owner/{id}/locations` | group locations |
| GET | `notifications/most-relevant/v1?groupOwnerID={id}` | `{messageType}` banner |
| POST | `patients/getrxlocalpatientmedications` | medsync/report med list. Body `{groupOwnerID, rxLocalPatientID, startDate, endDate, active}`. Needs the **medsync-scoped token** from `account/token/user`, NOT the plain bearer — plain bearer 401s. Prefer `refill/{id}/v2` for the normal med list. |

## Messaging (same-origin `/api/Messaging/*`)
| Method | Path | Body / Notes |
|---|---|---|
| POST | `Messaging/SyncPatientMessages` | `{RxLocalPatientID, GroupOwnerID, StartDate:null, EndDate:null, GetXMostRecentMessagesForDateRange:true, IsFirstDownloadOfMessages:true}` → `data.messagesToAddUpdate[]`. Row shape not yet field-mapped. |
| POST | `Messaging/CreatePatientMessage` | WRITE — send a message (not wired; read-only skill). |
| POST | `Messaging/EmployeeInfo` | pharmacy employee directory for a thread. |
| POST | `Messaging/UpdatePatientMessageStatus` | WRITE — mark read. |
| POST | `Messaging/Attachments` | message attachments. |

## Group / patient management (writes — not wired)
- `POST patients` · `POST patient/group/Owner/{owner}` (add) ·
  `DELETE patient/group/Owner/{owner}/Patient/{id}` (remove) ·
  `POST Account/VerifyPatientByPrescription {DataExchangeIdentifier, BornOn, LastName, RxNumber, RxLocalPatientID}`.

## Refill request flow (writes — not wired)
- `GET refill/location/{dataExchangeIdentifier}/conveyanceOptions?groupOwnerID={id}&rxlocalPatientID={id}`
  (header `rxlocaluserid`) · `POST refill/` to submit.

## Required headers summary
- Every call: `Authorization: Bearer <accessToken>`.
- Patient-data + messaging: also `rxlocaluserid: <globalUserID>`.
- A static app header `rxlocal_mobile_ss` exists in the bundle; it was NOT
  required for any read tested here — do not send it.

## Patient-data reachability (tested 2026-10-28)
`refill/{id}/v2`, `Messaging/SyncPatientMessages`, and `patients/{id}/*` return
**401 on a replayed request even with a freshly fpx-captured live Authorization
header** — i.e. the exact token the SPA itself uses. They are bound to the live
server-side session the SPA establishes on load (`PUT auth/session` +
`PUT account/token/user?forceUpdate=true`), so the token alone is insufficient.
Account endpoints (`getuserinfo`, `accountholderage`) are stateless and accept the
same token fine.

Untried: an **in-page** fetch (runs in the page's own origin/cookie context) —
`fpx profile declare rxlocal --allow-in-page` (re-pair once) + `RXLOCAL_INPAGE=1`.
If that still 401s, patient-data is not reachable through fpx and would need the
request issued by the SPA itself (out of scope for a shell skill).

Once a patient-data call returns 200, capture its row shape with
`<helper> raw GET refill/{id}/v2 | jq '.[0]|keys'` and project in `scripts/rxlocal`.