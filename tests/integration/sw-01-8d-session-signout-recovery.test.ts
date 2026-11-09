import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { createSessionSignOutCoordinator } from "@/services/auth/session-signout-operations";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production" || process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== projectId) {
  throw new Error("SW-01.8D tests require demo-homegrid and local Firebase emulators.");
}
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:sw-01-8d-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type PrincipalFixture = { uid: string; cookie: string; role: "customer" | "superAdmin" };
const fixtures: PrincipalFixture[] = [];
const operationIds = new Set<string>();
const targetUids = new Map<string, string>();
let adminAuth: Auth;
let adminDb: Firestore;

async function principal(role: PrincipalFixture["role"]): Promise<PrincipalFixture> {
  const [{ getFirebaseAuth }, { getFirebaseAdminAuth, getFirebaseAdminFirestore }, { createUserWithEmailAndPassword, signOut }] = await Promise.all([
    import("@/infrastructure/firebase/client"),
    import("@/infrastructure/firebase/admin"),
    import("firebase/auth"),
  ]);
  adminAuth = getFirebaseAdminAuth();
  adminDb = getFirebaseAdminFirestore();
  const email = `sw018d-${role}-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(await getFirebaseAuth(), email, "Emulator-Session-Recovery-42!");
  const uid = credential.user.uid;
  await Promise.all([
    adminDb.collection("users").doc(uid).set({ uid, email, accountState: "active" }),
    adminDb.collection("userAccess").doc(uid).set({ uid, role, state: "active" }),
  ]);
  const idToken = await credential.user.getIdToken();
  const cookie = await adminAuth.createSessionCookie(idToken, { expiresIn: 300_000 });
  await signOut(await getFirebaseAuth());
  const result = { uid, cookie, role };
  fixtures.push(result);
  return result;
}

function makeRequest(operationId: string, options: { cookie?: string; origin?: string; body?: unknown } = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new NextRequest(`http://localhost:3000/api/admin/session-signouts/${operationId}/retry`, {
    method: "POST",
    headers: {
      origin: options.origin ?? "http://localhost:3000",
      ...(options.cookie ? { cookie: `homegrid_session=${options.cookie}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

async function seedOperation(overrides: Record<string, unknown> = {}) {
  const operationId = randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64);
  const uid = `stored-user-${randomUUID()}`;
  operationIds.add(operationId);
  targetUids.set(operationId, uid);
  await Promise.all([
    adminDb.collection("userAccess").doc(uid).set({ uid, role: "customer", state: "suspended" }),
    adminDb.collection("users").doc(uid).set({ uid, accountState: "disabled" }),
    adminDb.collection("sessionSignOutOperations").doc(operationId).set({
    operationId,
    uid,
    authTime: 0,
    actorRole: "customer",
    status: "manualReview",
    attemptCount: 5,
    manualReviewCount: 0,
    correlationId: `correlation-${operationId}`,
    lastFailurePhase: "auth-revocation",
    lastFailureCode: "auth/operation-not-allowed",
    lastFailureAt: new Date(),
    leaseToken: "old-token",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
    }),
  ]);
  return { operationId, uid };
}

async function route() {
  return import("@/app/api/admin/session-signouts/[operationId]/retry/route");
}

async function auditEvents(operationId: string) {
  const result = await adminDb.collection("auditEvents").where("resourceId", "==", operationId).get();
  return result.docs;
}

test("SW-01.8D audited session sign-out manual-review recovery", async (t) => {
  const firebaseAdmin = await import("@/infrastructure/firebase/admin");
  adminAuth = firebaseAdmin.getFirebaseAdminAuth();
  adminDb = firebaseAdmin.getFirebaseAdminFirestore();
  const operator = await principal("superAdmin");
  const customer = await principal("customer");
  const handler = await route();

  await t.test("requires an active users.manage session and same-origin request", async () => {
    const record = await seedOperation();
    assert.equal((await handler.POST(makeRequest(record.operationId), { params: Promise.resolve({ operationId: record.operationId }) })).status, 401);
    assert.equal((await handler.POST(makeRequest(record.operationId, { cookie: operator.cookie, origin: "https://attacker.example" }), { params: Promise.resolve({ operationId: record.operationId }) })).status, 403);
    const denied = await handler.POST(makeRequest(record.operationId, { cookie: customer.cookie }), { params: Promise.resolve({ operationId: record.operationId }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "Permission is not granted.");
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()?.status, "manualReview");
  });

  await t.test("rejects a client UID, invalid or missing operation safely", async () => {
    const record = await seedOperation();
    assert.equal((await handler.POST(makeRequest(record.operationId, { cookie: operator.cookie, body: { uid: "attacker-selected-uid" } }), { params: Promise.resolve({ operationId: record.operationId }) })).status, 400);
    assert.equal((await handler.POST(makeRequest("not-an-operation-id", { cookie: operator.cookie }), { params: Promise.resolve({ operationId: "not-an-operation-id" }) })).status, 400);
    const missingId = "f".repeat(64);
    assert.equal((await handler.POST(makeRequest(missingId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: missingId }) })).status, 404);
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()?.uid, record.uid);
  });

  await t.test("requeues manual review atomically and treats duplicates by current status", async () => {
    const record = await seedOperation();
    const response = await handler.POST(makeRequest(record.operationId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: record.operationId }) });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { operationId: record.operationId, status: "pending", manualReviewCount: 1 });
    const operation = (await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()!;
    assert.equal(operation.uid, record.uid);
    assert.equal(operation.operationId, record.operationId);
    assert.equal(operation.status, "pending");
    assert.equal(operation.attemptCount, 0);
    assert.equal(operation.manualReviewCount, 1);
    assert.equal(operation.leaseToken, undefined);
    assert.equal(operation.lastFailureCode, undefined);
    assert.equal((await adminDb.collection("userAccess").doc(record.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb.collection("users").doc(record.uid).get()).data()?.accountState, "disabled");
    const events = await auditEvents(record.operationId);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, `${record.operationId}-manual-retry-1`);
    assert.equal(events[0].data().actorUid, operator.uid);
    assert.equal(events[0].data().actorRole, "superAdmin");
    assert.equal(events[0].data().action, "auth.session.sign_out.retry-requested");
    assert.equal((await handler.POST(makeRequest(record.operationId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: record.operationId }) })).status, 409);
    assert.equal((await auditEvents(record.operationId)).length, 1);
  });

  await t.test("pending, processing, and completed operations are never reset", async () => {
    for (const status of ["pending", "processing", "completed"] as const) {
      const record = await seedOperation({ status, ...(status === "processing" ? { leaseToken: "active-lease", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}) });
      const response = await handler.POST(makeRequest(record.operationId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: record.operationId }) });
      assert.equal(response.status, status === "completed" ? 200 : 409);
      const stored = (await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()!;
      assert.equal(stored.status, status);
      assert.equal(stored.uid, record.uid);
      assert.equal((await auditEvents(record.operationId)).length, 0);
    }
  });

  await t.test("concurrent retry requests create only one logical transition and audit", async () => {
    const record = await seedOperation();
    const responses = await Promise.all([
      handler.POST(makeRequest(record.operationId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: record.operationId }) }),
      handler.POST(makeRequest(record.operationId, { cookie: operator.cookie }), { params: Promise.resolve({ operationId: record.operationId }) }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()?.manualReviewCount, 1);
    assert.equal((await auditEvents(record.operationId)).length, 1);
  });

  await t.test("audit staging and commit failures leave manual review unchanged", async () => {
    for (const mode of ["stage", "commit"] as const) {
      const record = await seedOperation();
      const retryCount = 1;
      const eventRef = adminDb.collection("auditEvents").doc(`${record.operationId}-manual-retry-${retryCount}`);
      if (mode === "commit") await eventRef.set({ existing: true });
      const runner = createSessionSignOutCoordinator({
        db: adminDb,
        auth: { async revokeRefreshTokens() { throw new Error("manual retry must not call Auth"); } },
        stageAudit: mode === "stage" ? () => { throw new Error("audit staging rejected"); } : (transaction, ref) => transaction.create(ref, { collision: true }),
      });
      await assert.rejects(runner.retryManualReview(record.operationId, { uid: operator.uid, role: "superAdmin" }));
      const current = (await adminDb.collection("sessionSignOutOperations").doc(record.operationId).get()).data()!;
      assert.equal(current.status, "manualReview");
      assert.equal(current.uid, record.uid);
      assert.equal(current.manualReviewCount, 0);
      await eventRef.delete().catch(() => undefined);
    }
  });

  await t.test("the existing bounded processor revokes only the stored UID and keeps failure policy", async () => {
    const success = await seedOperation({ manualReviewCount: 1 });
    for (const operationId of operationIds) {
      if (operationId !== success.operationId) await adminDb.collection("sessionSignOutOperations").doc(operationId).delete().catch(() => undefined);
    }
    const revoked: string[] = [];
    const runner = createSessionSignOutCoordinator({ db: adminDb, auth: { async revokeRefreshTokens(uid) { revoked.push(uid); } }, maxAttempts: 1 });
    const accepted = await runner.retryManualReview(success.operationId, { uid: operator.uid, role: "superAdmin" });
    assert.equal(accepted.status, "retryRequested");
    const summary = await runner.processPending({ maxCandidates: 10, maxClaimedOperations: 1, maxPages: 2, pageSize: 10, concurrency: 1 });
    assert.equal(summary.completedOperations, 1);
    assert.deepEqual(revoked, [success.uid]);
    assert.equal((await adminDb.collection("userAccess").doc(success.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb.collection("users").doc(success.uid).get()).data()?.accountState, "disabled");

    const failure = await seedOperation({ manualReviewCount: 1 });
    const failing = createSessionSignOutCoordinator({
      db: adminDb,
      auth: { async revokeRefreshTokens() { throw Object.assign(new Error("private auth detail"), { code: "auth/operation-not-allowed" }); } },
      maxAttempts: 1,
    });
    assert.equal((await failing.retryManualReview(failure.operationId, { uid: operator.uid, role: "superAdmin" })).status, "retryRequested");
    const failedSummary = await failing.processPending({ maxCandidates: 10, maxClaimedOperations: 1, maxPages: 2, pageSize: 10, concurrency: 1 });
    assert.equal(failedSummary.manualReviewOperations, 1);
    const result = await failing.get(failure.operationId);
    assert.ok(result);
    assert.equal(result.status, "manualReview");
  });
});

after(async () => {
  if (!adminAuth || !adminDb) return;
  for (const id of operationIds) {
    await adminDb.collection("sessionSignOutOperations").doc(id).delete().catch(() => undefined);
    const events = await adminDb.collection("auditEvents").where("resourceId", "==", id).get().catch(() => undefined);
    if (events) await Promise.all(events.docs.map((event) => event.ref.delete().catch(() => undefined)));
    const uid = targetUids.get(id);
    if (uid) {
      await adminDb.collection("users").doc(uid).delete().catch(() => undefined);
      await adminDb.collection("userAccess").doc(uid).delete().catch(() => undefined);
    }
  }
  for (const fixture of fixtures) {
    await adminDb.collection("users").doc(fixture.uid).delete().catch(() => undefined);
    await adminDb.collection("userAccess").doc(fixture.uid).delete().catch(() => undefined);
    await adminAuth.deleteUser(fixture.uid).catch(() => undefined);
  }
  const { getApps, deleteApp } = await import("firebase/app");
  await Promise.all(getApps().map((app) => deleteApp(app)));
  const { getApps: getAdminApps, deleteApp: deleteAdminApp } = await import("firebase-admin/app");
  await Promise.all(getAdminApps().map((app) => deleteAdminApp(app)));
});
