# Security principles

## Authority and access

- Authentication and authorization are server-side responsibilities.
- The client never establishes its own authoritative role or permissions.
- Each server request must verify the actor and the requested resource scope.
- Customer resources require ownership and household membership checks.
- Installer resources require assigned installation scope checks.
- Super Admin access is platform administration only. It never includes appliance control or household automation writes.

## Device and service boundaries

- Do not define or guess MQTT topics, payloads, firmware APIs, commands or telemetry schemas.
- HomeGrid HQ approves device communication contracts before implementation.
- MQTT connections, when approved in a later work package, must use TLS.
- Test/simulated devices must be visibly and structurally distinct from physical devices.
- Privileged Firebase and service credentials belong in a managed secret store or local environment, never source control.
- Firebase client API key, app ID, project ID and auth domain are public identifiers; private credentials must never use a `NEXT_PUBLIC_` variable.
- Firebase Admin code imports `server-only`; non-emulator credentials come from ADC or a runtime workload identity, not bundled files.
- Emulator mode requires an explicit flag, local endpoints and a `demo-*` project ID. Both client and server initialization reject emulator mode in production.
- The SW-01.5 simulator additionally requires matching client/Admin demo project IDs, both emulator flags, loopback Auth and Firestore endpoints on the configured ports, and successful local TCP checks before simulator service operations. Its page and APIs return not-found when production or emulator configuration is unsafe. Fixture cleanup is a test utility that requires an explicit cleanup flag and removes only records created by its fixture instance.
- Session cookies are HttpOnly, SameSite=Lax, Secure in production, limited to five days, and issued only for a same-origin request after recent ID-token authentication. Server verification checks token revocation.
- Email/password registration creates an Auth account only. It does not create `userAccess`, custom claims or privileged role assignments.
- Active application access requires a signed, non-revoked session; active `userAccess/{uid}` and `users/{uid}` records; no pending/manual-review account access operation; and an enabled Auth account. Firestore denial is checked before Auth account state so suspension intent immediately blocks protected requests.
- Account suspension/reactivation uses a server-only Firestore outbox. Auth disable/enable and refresh-token revocation run outside retryable Firestore transactions. Reactivation does not restore application access until the final Firestore transaction completes.
- Session sign-out commits a per-session intent and request audit before Firebase Auth refresh-token revocation. The outbox key is a SHA-256 digest of the signed session cookie; the cookie, ID token and refresh token are never persisted. Completion status and the session-ended audit commit together. A matching pending sign-out intent denies that exact session in server authorization. Revocation and Firestore finalization failures are sanitized and retryable; permanent/exhausted failures enter manual review.
- Session sign-out manual-review recovery requires a same-origin active `users.manage` operator session. The server accepts only the existing opaque operation ID, derives the immutable target UID from the stored outbox record, and atomically requeues only `manualReview` with a deterministic operator audit event. The API performs no Auth call; the established processor revokes refresh tokens. It cannot enable an account, restore HomeGrid access, alter roles, or change permissions. The audit schema has no reason/reference field, so this API accepts no free-text metadata.
- Outbox processors use indexed due-work queries instead of scanning entire collections. Candidate, claim, page, runtime and concurrency limits are independent controls. Processing leases are renewed transactionally while Firebase Auth calls are in flight; operation lease tokens fence stale processors from subsequent checkpoints and final writes. Account-access and session-sign-out summaries, retries and failures remain isolated by domain.
- `npm run process:session-signouts:demo` is restricted to `demo-homegrid` and local Auth/Firestore emulators. It is a local recovery command, not a production scheduler or worker. Production retry ownership and monitoring must be established before deployment.
- Firestore client rules deny all access. Admin SDK bypasses those rules; each Admin-backed operation must use the server authorization and scoped service layer.
- Super Admin grants are excluded from application provisioning. The first Super Admin uses the one-time trusted bootstrap command below.

## Audit and change control

- Log security-sensitive operations with actor UID and role, action, resource, timestamp, outcome and correlation ID while avoiding unnecessary sensitive data.
- Architecture changes require a documented proposal before implementation.
- Review authorization and data-access behavior at the server boundary; hiding a UI control is not access control.

## Current implementation status

SW-01.3 adds explicit role permissions, protected server pages and APIs, household membership checks, assigned-installation checks, platform administration services, account provisioning/suspension, audit metadata and emulator security tests. Firestore client access remains deny-all. Super Admin does not receive appliance-control or household-automation-write capabilities, and those APIs are not implemented.

## One-time Super Admin bootstrap

The initial Super Admin must be an enabled Firebase Auth identity created through the organization's trusted identity process. An operator with approved ADC access to the intended Firebase project sets `FIREBASE_PROJECT_ID` and `HOMEGRID_BOOTSTRAP_UID`, then runs `npm run bootstrap:super-admin` from a trusted workstation or controlled administration environment. The command refuses demo/emulator projects, refuses a second bootstrap, refuses an existing access record, and atomically creates the role record and bootstrap marker. Remove `HOMEGRID_BOOTSTRAP_UID` from the operator environment immediately after the run. Do not put the UID in a public form, deployment variable, repository file, or build artifact. Restrict ADC/IAM access to authorized operators; possession of broad Firestore write access is itself privileged.
