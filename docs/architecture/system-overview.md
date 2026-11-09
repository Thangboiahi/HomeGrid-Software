# System overview

## Product shape

HomeGrid is one web application with three role experiences: Customer, Installer and Super Admin. Authentication and authorization are enforced on the server. Route groups express the experience boundaries in the codebase; they are not security controls on their own.

## Request and trust boundaries

```text
Browser
  │ UI and user input; never an authority for role or permission
  ▼
Next.js App Router
  │ server-side session verification, role authorization, validation and orchestration
  ▼
Application services
  ├── Firebase client SDK (email/password setup and Firestore client; client rules deny all access)
  ├── Firebase Admin SDK (server-only Auth and Firestore adapters)
  └── Approved backend/device integration boundary (future)
         │
         └── MQTT over TLS only after HomeGrid HQ approves an integration contract
```

### Frontend

`src/app` contains route composition and page-level UI. Shared components and role-specific features live under `src/components` and `src/features`. The browser may submit requests and display server-authorized results; it must never supply the authoritative role or access decision. Firebase Web SDK setup is isolated in `src/infrastructure/firebase/client.ts`; its configuration values are public identifiers, not secrets.

### Backend services

Next.js server code and future services under `cloud-run/` own authentication checks, authorization decisions, input validation and sensitive orchestration. `src/services/auth/authorization.ts` verifies the signed/revocable session, enabled Auth account, active Firestore account state, role and explicit permission. Customer data services enforce household membership; installer services enforce assigned-installation scope and recheck mutations transactionally. Administrative services are permission-checked independently of route or UI visibility. The Admin SDK lives behind `server-only` in `src/infrastructure/firebase/admin.ts` and uses Application Default Credentials outside emulator mode. Session creation verifies an ID token and recent authentication before setting a five-day HttpOnly cookie. Security-sensitive operations emit audit records with actor role and correlation ID.

### Firebase

Firebase Authentication and Cloud Firestore are used for identity, server-managed account access and application data. Local development/tests use the Auth and Firestore emulators with the `demo-homegrid` project. Firestore client rules deny every read and write; authenticated application reads/writes pass through scoped server APIs. Admin operations bypass Firestore rules and must use the permission-checked services. Non-emulator Admin access uses ADC (a local gcloud credential or a Cloud Run runtime identity); no service-account key is stored in the repository. See [Firebase setup](../firebase-setup.md).

### Device integration

SW-01.5 adds a software-side registry simulator at `/super-admin/simulator`. The page and its `/api/dev/simulator/*` endpoints are available only outside production when both client and Admin SDK configuration explicitly target the local Auth and Firestore emulators using a matching `demo-*` project. The server verifies both configured loopback emulator ports before simulator service access. Simulator creation and association reuse existing registry services and audit transactions; simulator listing filters for `kind: simulated`. Test fixture cleanup is confined to the emulator test helper and is guarded by an explicit test flag plus the same emulator checks.

The simulator represents registry presence and associations only. It defines no MQTT broker, topics, payloads, firmware endpoints, commands, telemetry, appliance state, connectivity state, or physical-device communication. A Firestore device ID remains only a software record identifier. Any future integration must follow a contract approved by HomeGrid HQ; MQTT over TLS is a future approved boundary, not an implemented connection.

## Role boundaries

- **Customer:** household resources require verified ownership and membership.
- **Installer:** access is limited to assigned installation scope.
- **Super Admin:** manages the HomeGrid platform; never receives appliance-control or household-automation-write capabilities.

## Current milestone boundary

SW-01.1 through SW-01.6B establish the application, Firebase client/Admin initialization, email/password authentication workflows, server session cookies, explicit RBAC, scoped server data operations, account provisioning, audit records, device registry workflows, role-specific browser workflows, a local-emulator-only simulator and deny-by-default Firestore client rules. SW-01.6C records that production device contracts remain undefined and deployment operations are not yet configured. MQTT connectivity, appliance control, OTA and physical device communication remain outside scope. Any later device contract must be approved through HomeGrid HQ. See the [SW-01.6C readiness report](../milestone-reports/SW-01.6C-integration-readiness.md) and [integration matrix](integration-readiness-matrix.md).
