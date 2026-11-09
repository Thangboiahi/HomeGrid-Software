# Technology decisions

## Current baseline

| Area | Decision | Reason |
| --- | --- | --- |
| Web framework | Next.js 16.4.5 App Router | Stable current major and server/client composition in one application; patched release |
| Language | TypeScript 5.9.3, strict mode | Type-safe foundation across routes and future service boundaries |
| UI styling | Tailwind CSS 4.3.3 | Utility-first responsive styling |
| Component convention | shadcn/ui-compatible setup | Components remain repository-owned and accessible to adapt; `components.json` and `cn` helper establish conventions without importing an opaque UI runtime |
| Runtime | Node.js 24 LTS | Supported LTS runtime compatible with Next.js |
| Package manager | npm | Lockfile-based reproducible installs via `npm ci` |
| Linting | ESLint 9 with Next.js rules | Explicit lint command independent of build behavior |
| Firebase client | Firebase JavaScript SDK 13.2.0 | Browser Auth and Firestore SDKs; Firestore rules remain deny-by-default |
| Firebase server | Firebase Admin SDK 14.5.0 | Server-only Auth and Firestore access with ADC outside emulator mode |
| Emulator Suite | firebase-tools 15.35.0 | Pinned local Auth and Firestore emulators with UI |
| Runtime floor | Node.js 24.12.0 | Required by the selected Firebase Firestore SDK; Node 24 LTS |

Versions are pinned exactly in `package.json` and `package-lock.json`. Upgrade versions deliberately and update this record when the baseline changes.

## Architecture decisions

1. One application hosts the Customer, Installer and Super Admin experiences.
2. App Router route groups organize role pages but do not enforce authorization.
3. Server-side code owns authentication, authorization and data access decisions.
4. Domain, feature, service, infrastructure, validation and shared code have distinct homes under `src/`.
5. Firebase and Cloud Run directories are reserved integration boundaries, not active integrations.
6. Any MQTT/TLS communication contract must be approved through HomeGrid HQ before implementation.
7. Firebase Web and Admin SDKs have separate modules; the Admin module uses the `server-only` boundary.
8. Firebase emulators require explicit opt-in, both service endpoints, and a `demo-*` project ID. Production startup rejects emulator configuration.
9. Firestore client rules continue to deny all browser reads and writes. Server access uses the Admin SDK behind the authenticated, permission-checked service layer; any future client-access change requires a separate approved security design.
10. Admin SDK access bypasses Firestore rules and remains inside trusted server code; every future operation needs explicit authorization.

Proposed changes to these decisions must be documented before implementation, as required by the repository engineering rules.
