# HomeGrid Software

HomeGrid is a single application for smart living, with separate customer, installer and Super Admin experiences.

> **Smart living. Reliable by design.**

This repository contains the SW-01.1 through SW-01.6B software foundations, with the SW-01.6C integration-readiness review recorded in the milestone reports. It establishes the application structure, Firebase client/Admin boundaries, server-side sessions and account authorization, role-scoped services and APIs, trusted account provisioning, emulator-backed security tests, role-specific browser workflows, a local-emulator-only software device simulator, and deny-by-default Firestore client rules. Physical device communication remains outside scope.

## Stack

- Next.js 16.4.5 App Router with React 19.3.0
- TypeScript 5.9.3 in strict mode
- Tailwind CSS 4.3.3 with shadcn/ui-compatible component conventions
- Node.js 24.12.0 or newer in the Node.js 24 LTS line and npm 11 or newer

Dependency versions are exact in `package.json`; `package-lock.json` pins the complete dependency graph.

## Getting started

Use Node.js 24.12.0 or newer in the Node.js 24 LTS line and npm 11 or newer, then run:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

The application is served at `http://localhost:3000`.

## Routes

- `/` HomeGrid landing page
- `/auth` email/password sign-in and registration; registration creates an Auth identity only, and application access requires trusted provisioning
- `/customer` server-protected Customer workspace with household-scoped device and installation information
- `/installer` server-protected Installer workspace with assigned-installation and device information
- `/super-admin` server-protected platform administration and authorized registry workflows; no appliance controls
- `/super-admin/simulator` development simulator (server-protected; hidden unless local Auth and Firestore demo emulators are explicitly configured)

The role workspaces provide the accepted SW-01.6A/B authentication and role-specific workflows. Protected APIs enforce the current session, active account, explicit permissions and resource scope. Browser visibility is not used as authorization. Customer access is household-membership-scoped; Installer access is assigned-installation-scoped; Super Admin access is limited to platform operations.

The device registry and simulator manage software records only. `simulated` records are visibly distinguished from `physical`-classified registry records. A Firestore document ID is a HomeGrid software record identifier, not proof of physical-device identity. No MQTT, provisioning, device telemetry, appliance control or OTA integration is implemented; see the [SW-01.6C integration readiness report](docs/milestone-reports/SW-01.6C-integration-readiness.md) and [integration matrix](docs/architecture/integration-readiness-matrix.md).

## Repository map

```text
src/
  app/                   App Router, route groups, layouts and global styles
  components/            Shared and UI components
  domain/                Domain types and policies
  features/              Role and product feature modules
  infrastructure/        External platform adapters
  services/              Application service boundary
  shared/                Shared utilities
  validation/            Input validation boundary
firebase/                Emulator Suite config, Firestore rules and indexes
cloud-run/               Reserved for future backend service deployment assets
tests/                   Firebase Emulator integration tests
scripts/                 Trusted operator utilities; never exposed as web routes
docs/                    Architecture, data, security and integration docs
```

## Commands

- `npm run dev` starts local development.
- `npm run lint` runs ESLint.
- `npm run typecheck` runs the strict TypeScript check.
- `npm run build` creates the production build.
- `npm run firebase:emulators:start` starts Auth, Firestore and the Emulator UI.
- `npm run test:firebase` runs the emulator integration suite and shuts emulators down.
- `npm run test:firebase:auth` tests Auth Emulator connectivity without Java.
- `npm run test:unit` checks device validation, simulator rules, session policy, role permissions and role-specific view rendering.
- `npm run test:security` runs role-isolation and privilege-escalation integration tests on local emulators.
- `npm run test:simulator` runs simulator isolation, registry workflow, authorization, audit and fixture-cleanup tests on local emulators.
- `npm test` runs unit, security, simulator and Firebase integration suites.
- `npm run bootstrap:super-admin` performs the documented one-time trusted initial Super Admin bootstrap; set its required variables only in a controlled operator environment.

The production build uses Next.js's Webpack builder for compatibility with the Windows development environment; the App Router code remains compatible with Next.js's default Turbopack development server.

See [System overview](docs/architecture/system-overview.md), [Technology decisions](docs/architecture/technology-decisions.md), [Security principles](docs/security/security-principles.md), [Authorization model](docs/security/authorization-model.md), and [Firebase setup](docs/firebase-setup.md). All contributors and agents must follow [AGENTS.md](AGENTS.md).
