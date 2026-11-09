# Firestore collection foundation

This document defines TypeScript application-domain document shapes for initial collections. They are not firmware schemas or wire protocols. All client access is denied by the current rules. Server-side access is scoped and authorized in the service layer.

| Collection | Initial purpose and key fields |
| --- | --- |
| `users` | Firebase UID, optional basic profile fields and account state. |
| `userAccess` | Server-managed role and access state, keyed by user UID. Registration cannot write it. |
| `accountAccessOperations` | Server-only, one-current-operation-per-UID suspension/reactivation outbox. Stores operation ID/kind/status, requester and correlation ID, bounded retry count, lease, timestamps, last completed Auth step and sanitized failure code. It never stores credentials, tokens or raw Auth responses. Client rules deny all access. Append-only audit events retain the operation history when a later operation replaces the current outbox record. Worker discovery uses due `pending/nextAttemptAt` and expired `processing/leaseExpiresAt` indexed queries. |
| `sessionSignOutOperations` | Server-only, per-session sign-out outbox. The document ID is SHA-256 of the signed session cookie; fields include UID, auth time, actor role, status, automatic attempt count, manual review/retry round count, correlation ID, lease/retry timestamps and sanitized failure phase/code. It never stores the cookie, ID token, refresh token or credentials. Request/failure/completion/manual-retry audit events use deterministic IDs. Client rules deny all access. Worker discovery uses due `pending/nextAttemptAt` and expired `processing/leaseExpiresAt` indexed queries. |
| `customers` | Customer record with primary UID and state. |
| `households` | Display name, creator UID and member UIDs; customer reads verify membership on the server. |
| `installers` | Installer UID, optional organization ID and state. |
| `productDefinitions` | Product code, display name and lifecycle state; no communication contract fields. |
| `devices` | Product definition reference, `simulated` or `physical` kind, registry lifecycle state and optional household/installation references. SW-01.5 simulator records use this same shape with `kind: simulated`; no simulator-only hardware identity or connectivity fields are added. A Firestore ID is only a software record identifier, not physical identity. Retirement/reactivation transitions are not exposed until lifecycle policy is approved. No commands, telemetry, topics or payloads. |
| `installations` | Installer, customer, optional household, workflow state, schedule/completion timestamps and bounded installer completion note. |
| `firmwareReleases` | Product reference, human-readable version label and approval lifecycle only. No artifact, OTA or firmware transport schema. |
| `diagnosticRecords` | Application/support summary and subject reference. No device telemetry payload schema. |
| `auditEvents` | Actor UID and role, optional trusted executor label, action, resource, outcome, correlation ID and occurrence timestamp. Treat as append-only through server services. Firestore-only privileged business mutations commit the success event in the same transaction. Account access and session sign-out request/completion phases are also transactional; the Firebase Auth calls between them are external and are represented by outbox state rather than a distributed transaction. |

The corresponding TypeScript interfaces are in `src/domain/firestore/models.ts`. Field changes require architecture/data-model review and must not be used to infer firmware interfaces.

Outbox worker indexes are defined in `firebase/firestore.indexes.json`. A run bounds candidate count, claim count, page count, concurrency and runtime independently. Existing account and session lease durations remain five minutes and one minute. Heartbeats renew active leases transactionally; the existing lease token fences stale processors from checkpoint, failure and completion writes.
