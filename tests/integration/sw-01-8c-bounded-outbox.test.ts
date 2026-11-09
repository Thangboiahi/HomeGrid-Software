import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { createSessionSignOutCoordinator } from "@/services/auth/session-signout-operations";
import { resolveOutboxRunBudget, selectDueOutboxCandidates } from "@/services/security/outbox-processing";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production" || process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== projectId) {
  throw new Error("Bounded outbox tests require the demo-homegrid project and local emulators.");
}
Object.assign(process.env, { FIREBASE_PROJECT_ID: projectId, NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId, FIREBASE_USE_EMULATORS: "true", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" });

const db = getFirebaseAdminFirestore();
const refs = Array.from({ length: 7 }, () => db.collection("sessionSignOutOperations").doc(`sw018c-${randomUUID()}`));
after(async () => { await Promise.all(refs.map((ref) => ref.delete())); });

test("indexed candidate selection includes due and expired work only, within page and candidate budgets", async () => {
  const now = Date.now();
  await Promise.all([
    refs[0].set({ operationId: refs[0].id, status: "pending", nextAttemptAt: Timestamp.fromMillis(now - 1000) }),
    refs[1].set({ operationId: refs[1].id, status: "pending", nextAttemptAt: Timestamp.fromMillis(now + 60_000) }),
    refs[2].set({ operationId: refs[2].id, status: "processing", leaseExpiresAt: Timestamp.fromMillis(now - 1000) }),
    refs[3].set({ operationId: refs[3].id, status: "processing", leaseExpiresAt: Timestamp.fromMillis(now + 60_000) }),
    refs[4].set({ operationId: refs[4].id, status: "completed", nextAttemptAt: Timestamp.fromMillis(now - 1000) }),
    refs[5].set({ operationId: refs[5].id, status: "pending", nextAttemptAt: Timestamp.fromMillis(now - 1000) }),
    refs[6].set({ operationId: refs[6].id, status: "pending", nextAttemptAt: Timestamp.fromMillis(now - 1000) }),
  ]);
  const budget = resolveOutboxRunBudget({ maxCandidates: 2, maxPages: 2, pageSize: 2, concurrency: 1, maxClaimedOperations: 1 }, now);
  const selected = await selectDueOutboxCandidates(db.collection("sessionSignOutOperations"), budget, () => now);
  assert.equal(selected.candidates.length, 2);
  assert.equal(selected.pagesRead, 2);
  assert.equal(selected.candidates.every((doc) => refs.some((ref) => ref.id === doc.id && [0, 2, 5, 6].some((i) => refs[i].id === doc.id))), true);
  const allDue = await selectDueOutboxCandidates(db.collection("sessionSignOutOperations"), resolveOutboxRunBudget({ maxCandidates: 10, maxPages: 4, pageSize: 2 }, now), () => now);
  const selectedIds = new Set(allDue.candidates.map((doc) => doc.id));
  assert.equal(selectedIds.has(refs[0].id), true);
  assert.equal(selectedIds.has(refs[2].id), true);
  assert.equal(selectedIds.has(refs[1].id), false);
  assert.equal(selectedIds.has(refs[3].id), false);
  assert.equal(selectedIds.has(refs[4].id), false);

  const runner = createSessionSignOutCoordinator({ db, auth: { async revokeRefreshTokens() { throw new Error("must not be called when claim budget is zero"); } } });
  const summary = await runner.processPending({ maxClaimedOperations: 0, maxCandidates: 10, maxPages: 4, pageSize: 3 });
  assert.equal(summary.claimAttempts, 0);
  assert.equal(summary.claimedOperations, 0);
  assert.equal((await refs[0].get()).data()?.status, "pending");
});

test("candidate selection stops at an already-reached deadline", async () => {
  const now = Date.now();
  const budget = resolveOutboxRunBudget({ deadlineAt: now, maxCandidates: 10 }, now);
  const selected = await selectDueOutboxCandidates(db.collection("sessionSignOutOperations"), budget, () => now);
  assert.equal(selected.pagesRead, 0);
  assert.equal(selected.deadlineReached, true);
});

test("candidate query infrastructure failures return an observable failed worker summary", async () => {
  const runner = createSessionSignOutCoordinator({
    db,
    auth: { async revokeRefreshTokens() { throw new Error("must not reach Firebase Auth"); } },
    candidateSelector: async () => { throw new Error("injected Firestore query failure"); },
  });
  const summary = await runner.processPending();
  assert.equal(summary.status, "failed");
  assert.equal(summary.failureCode, "outbox/candidate-query-failed");
  assert.equal(summary.operationErrors, 0);
});
