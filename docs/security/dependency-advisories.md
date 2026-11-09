# Dependency advisory review — SW-01.2

Reviewed with `npm audit` on 2026-11-08 after installing the SW-01.2 dependencies and applying non-forced fixes.

## Findings

- The eight SW-01.1 affected dependency entries trace to one development-only lint-graph advisory: `eslint-config-next` → `typescript-eslint` → `@typescript-eslint/typescript-estree` → `minimatch` 10.2.6. The advisory is GHSA-g3hv-75wg-m249 (moderate, globparts amplification denial of service). npm only offered an `--force` resolution by downgrading the Next lint preset to 15.5.29, which would mismatch Next.js 16. No forced change was applied.
- The current Firebase CLI toolchain adds moderate advisories in its development-only graph, including `@google-cloud/pubsub` → `@opentelemetry/core` (GHSA-8988-4f7v-96qf), `firebase-tools` → `archiver` / `exegesis` / `rimraf` → `glob` and `minimatch` (GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249), and `firebase-tools` → `gaxios` → `uuid` (GHSA-w5hq-g745-h8pq). npm's offered fix is to downgrade `firebase-tools` from 15.35.0 to 13.11.2, a breaking major downgrade. `npm audit fix` without `--force` was run; these remain.
- A high advisory initially appeared through Firebase Web Firestore's `@grpc/grpc-js` 1.9.16 dependency (GHSA-m9gg-hp2v-232j; also a low error-message disclosure advisory). A scoped package override now resolves that edge to 1.14.7, matching the patched Admin SDK tree. The high and low gRPC findings cleared in the subsequent audit.

No `npm audit fix --force` was run. The full audit reports 20 moderate affected dependency entries and no high or critical findings. `npm audit --omit=dev` reports zero production advisories. Re-run `npm audit` after dependency updates because these advisories and available releases can change.
