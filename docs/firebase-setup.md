# Firebase and Emulator Suite setup

## Prerequisites

- Node.js 24.12.0 or newer in the Node.js 24 LTS line and npm 11 or newer.
- Java JDK 21 or newer for the Firestore Emulator.
- A Firebase CLI version installed from this repository's pinned `firebase-tools` dependency.

## Local emulator development

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env.local`. It defaults to the isolated `demo-homegrid` project and emulator mode; it contains no production credentials.
3. Start the suite with `npm run firebase:emulators:start`.
4. In another terminal, start the application with `npm run dev`.
5. Open the Emulator UI at `http://127.0.0.1:4000`.
6. Stop the emulator process with **Ctrl+C** in its terminal.

The Super Admin development simulator is available at `/super-admin/simulator` only while running outside production with the matching local demo emulator configuration. It is not a production registration interface. Simulator API calls verify the Auth and Firestore emulator ports before accessing registry services. Use test fixture helpers for disposable test data; their cleanup is explicitly disabled outside the emulator-only test environment.

The suite binds Auth to `127.0.0.1:9099`, Firestore to `127.0.0.1:8080`, and the UI to `127.0.0.1:4000`. The client SDK is explicitly connected to those endpoints; the Admin SDK uses `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST`.

Run the integration suite, which starts and stops the emulators automatically:

```sh
npm run test:firebase
```

To test only client/Admin Authentication when Java is unavailable, run `npm run test:firebase:auth`; the full Firestore integration requires Java.

The suite follows the [Firebase Emulator Suite setup guide](https://firebase.google.com/docs/emulator-suite/install_and_configure), [Auth emulator connection guide](https://firebase.google.com/docs/emulator-suite/connect_auth), and [Firestore emulator connection guide](https://firebase.google.com/docs/emulator-suite/connect_firestore).

Firebase CLI caches emulator binaries outside this repository. First run may download them. Emulator data is ephemeral unless explicitly exported by a developer.

## Environment separation

- `FIREBASE_PROJECT_ID` is required on the server; `NEXT_PUBLIC_FIREBASE_PROJECT_ID` configures the browser SDK. Keep these values identical.
- Emulator mode requires both Auth and Firestore endpoints and a `demo-*` project ID.
- Production startup rejects the emulator flag or emulator host variables. Never deploy `.env.local` or emulator values to production.
- Firebase client configuration (API key, auth domain, project ID and app ID) is public app identification data. It is not a service credential.
- For non-emulator server environments, Firebase Admin uses Application Default Credentials (ADC). Locally, use `gcloud auth application-default login`; on Cloud Run, attach a least-privilege runtime service identity. If a local service-account file is required, keep it outside this repository and point `GOOGLE_APPLICATION_CREDENTIALS` at it.
- Do not create or check in service-account JSON, private keys or production `.env` files.

## Current security boundary

`firebase/firestore.rules` denies all client reads and writes. Firebase Admin operations bypass these rules, so only trusted server modules may use the Admin SDK and every operation must pass explicit permission and scope checks in its server service. Application APIs expose only role-scoped operations; do not add general-purpose Firestore endpoints or client `userAccess` writes. See [authorization model](security/authorization-model.md).

Enable Email/Password in the Firebase Console for a real project before using that provider outside emulators. Registration only creates a Firebase Auth account; it does not write `userAccess`, set custom claims, or assign Installer/Super Admin access.

The session endpoint accepts only a recent ID token from the configured same origin, issues a five-day cookie, and records session creation/end events in `auditEvents`. Protected requests additionally require an active `userAccess` record and enabled Auth account. If Firestore audit persistence is unavailable, a structured fallback is written to server stderr/Cloud Logging; no token or credential is logged. See the [Firebase session cookie guide](https://firebase.google.com/docs/auth/admin/manage-cookies).
