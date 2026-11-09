# Authorization model

## Trusted identity and account state

The browser receives only an HttpOnly `homegrid_session` cookie. Protected pages and API routes call the server-only authorization service, which verifies the signed session cookie with revocation checking and loads `userAccess/{uid}`, `users/{uid}`, `accountAccessOperations/{uid}` and the operation keyed by the hash of that exact session cookie. It rejects missing/inactive records and every pending, processing or manual-review operation before checking the Auth user's disabled status. A session with a durable sign-out intent is denied immediately; a completed sign-out is also denied by Firebase token-revocation verification. A completed suspension remains denied; only an active role/profile with no unfinished account or sign-out operation can proceed to Auth verification. Firebase custom claims and client request fields are not used as role authority.

Registrations create Firebase Auth identities only. No access record means no protected application access. A Super Admin can provision Customer and Installer accounts through the protected account API. Existing access records cannot be overwritten through that flow. Super Admin access is not assignable through any public or application API.

## Role-permission matrix

Permissions are explicit identifiers in `src/services/auth/permissions.ts`; there are no wildcard permissions.

| Capability | Customer | Installer | Super Admin |
| --- | --- | --- | --- |
| Read own profile | `profile.read.own` | `profile.read.own` | — |
| Read household/member resources | `households.read.member`, `devices.read.associated` | — | — |
| Read available installations | `installations.read.available` | — | — |
| Read/update assigned installations | — | `installations.read.assigned`, `installations.progress.update`, `installations.complete` | — |
| Read assigned-installation diagnostics | — | `diagnostics.read.assigned` | — |
| Manage users | — | — | `users.read`, `users.manage` |
| Manage product definitions | — | — | `products.read`, `products.manage` |
| Register/assign device records | — | — | `devices.read`, `devices.register`, `devices.assign` |
| Manage installation assignments | — | — | `installations.read`, `installations.manage` |
| Manage firmware release metadata | — | — | `firmwareReleases.manage` |
| Manage/review platform diagnostics and audit records | — | — | `diagnostics.read`, `diagnostics.manage`, `auditEvents.read` |

`appliances.operate`, `devices.commands.execute`, `appliances.state.write`, and `householdAutomation.write` are prohibited capabilities and are intentionally absent from every role's grant set. Super Admin has no household authorization and no operation endpoint exists for appliance control or household automation.

## Resource scope

- Customer household and device APIs verify Customer role/permission and check `memberUids` on the target household. Foreign or missing households return 404 to conceal resource existence. Device lookup is performed only after membership is established.
- Installer installation reads, diagnostics, progress and completion verify the assigned `installerUid`. State transitions are rechecked inside a Firestore transaction to avoid assignment/state time-of-check/time-of-use races. Completion requires a bounded completion note.
- Administrative mutation services perform the corresponding permission check themselves even when a route also checks it. This preserves the service boundary if another route is added later.
- SW-01.5 simulator routes are environment-gated before Firebase access and use the same registry services and permission checks. Device creation requires `devices.register`; adding associations also requires `devices.assign`; product reassignment additionally requires `products.manage`. Listing requires `devices.read`. These permissions remain limited to Super Admin. Customer and Installer simulator requests are denied even though their normal household/installation-scoped device reads may include simulated records.
- Firestore Security Rules continue to deny all browser reads and writes, including `userAccess`, audit records and household data. Admin SDK bypass is confined to server-only services.

## Provisioning lifecycle

1. Public email/password registration creates only a Firebase Auth account.
2. A trusted Super Admin can provision that existing identity as Customer or Installer. The service creates the profile, active `userAccess` record, and the matching customer/installer record. It will not replace an existing access document, assign `superAdmin`, or provision the caller's own UID.
3. The first Super Admin is created once through the operator-only `npm run bootstrap:super-admin` procedure documented in the security principles. The command uses ADC, a pre-created enabled Auth UID, and a Firestore transaction that creates a one-time bootstrap marker. Do not expose it as a web endpoint.
4. Suspension first commits `userAccess.state = suspended`, `users.accountState = disabled`, a server-only outbox intent and a request audit event in one Firestore transaction. Only afterward does the processor disable the Auth account and revoke refresh tokens. Protected requests are denied immediately after the Firestore commit even if Auth remains enabled.
5. Reactivation is separate. It records an intent while Firestore access remains suspended, enables Auth and revokes refresh tokens, then restores both Firestore account records to active in the same final transaction that records the completion audit. Failure at any earlier step leaves HomeGrid access denied.

The one-current-operation-per-UID outbox uses bounded retries, five attempts per automatic retry round, exponential backoff capped at one hour, and a five-minute processor lease. Permanent Auth errors or exhausted retries move the operation to `manualReview`; a Super Admin with `users.manage` must explicitly repeat the matching endpoint with `{"retryManualReview":true}` to start another round. Repeating a request for an already-completed consistent state is idempotent. A protected repeated suspension/reactivation request resumes a due pending operation; the local `npm run process:account-access-operations:demo` command scans pending/expired operations only against the demo emulators. No production worker, scheduler or Cloud Run service is deployed.

Session sign-out stores a separate per-session operation in `sessionSignOutOperations`, keyed by SHA-256 of the signed cookie. The cookie, ID token and refresh token are never stored. The same-origin sign-out route verifies the cookie signature without requiring an unrevoked token only to identify a new intent; an existing matching operation can be recovered after revocation or cookie expiry. A Firestore transaction creates the intent and `auth.session.sign_out.requested` audit together before Auth revocation. Revocation is repeated safely, and the completion status plus `auth.session.ended` audit commit in one transaction. Per-attempt sanitized failures are stored and audited. An active sign-out operation is checked by session authorization and denies that exact cookie. A one-minute fencing lease prevents concurrent processors from committing stale Firestore results. `npm run process:session-signouts:demo` retries due/expired operations only against demo emulators. This command is a local recovery tool; no production worker/scheduler is deployed. Permanent errors or five failed attempts enter terminal `manualReview`.

An active Super Admin with `users.manage` may request another attempt through the same-origin `POST /api/admin/session-signouts/{operationId}/retry` endpoint. It accepts only the existing opaque cookie-digest operation ID and derives the immutable target UID from the stored operation. A Firestore transaction changes only `manualReview` to due `pending`, resets the automatic attempt count, increments `manualReviewCount`, clears transient failure/lease fields, and appends a deterministic `auth.session.sign_out.retry-requested` audit event. Pending/processing requests conflict and completed operations remain completed. The endpoint does not call Firebase Auth; the existing bounded processor performs token revocation and can move permanent/exhausted failures back to `manualReview`. No user/account access state or role is changed.

Role changes are deliberately not available as a general update. Any future role transfer or recovery procedure requires separate review and audit.

## Audit events

Sensitive successful provisioning, account-access, product, device and installation operations record actor UID/role, action, target resource, outcome, server timestamp and a correlation ID. Firestore-only mutations commit their success audit event with the business write. Suspension and reactivation request/completion events are deterministic per operation phase; completion/failure records retain the requesting actor and label the trusted processor as `executor: system`. Auth calls are outside the retryable Firestore transaction and have durable progress/failure state in the outbox. Audit events are written with the Admin SDK; client access is denied. The audit writer excludes credentials, ID tokens, session cookies and private keys. Persistence failure produces a credential-free structured server log and a failed service response.

This transaction guarantee does not extend across Firebase Auth and Firestore. Account suspension/reactivation and session sign-out are fail-closed sagas: Firestore transactions persist intent and final state around Auth actions, while outboxes allow retries after process termination. Firebase token revocation and Firestore cannot share a distributed transaction; if revocation succeeds but finalization fails, the outbox remains retryable and repeat revocation is safe.

## HTTP behavior

Protected API handlers return 401 for missing/invalid/revoked sessions, 403 for a valid identity without active account access or permission, 404 for missing or concealed scoped resources, and 400 for invalid request data. Authorization is performed by the endpoint and again in the trusted data service; middleware or page visibility is not the API security boundary.

## Automated coverage

`npm run test:unit` checks permission separation and prohibited capabilities. `npm run test:security` exercises authenticated role fixtures, household and installation isolation, account suspension, client `userAccess` write denial, administrative operations and audit metadata. `npm run test:account-access` covers suspension/reactivation retries, failure injection, authorization and outbox consistency. `npm run test:session-signout` covers session outbox retries, failure injection, concurrency and cookie revocation. Both integration suites use only the demo Auth and Firestore emulators.
