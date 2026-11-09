import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore, type Transaction, type DocumentReference } from "firebase-admin/firestore";
import type { PreparedAuditEvent } from "@/services/audit/server-audit";
import { createSessionSignOutCoordinator, sessionSignOutOperationId } from "@/services/auth/session-signout-operations";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") throw new Error("Session sign-out tests cannot run in production.");
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:sw-01-8a-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type Fixture = { uid: string; cookie: string };
const fixtures: Fixture[] = [];
const operationIds = new Set<string>();
let adminAuth: Auth;
let adminDb: Firestore;

async function fixture(): Promise<Fixture> {
  const [{ getFirebaseAuth }, { getFirebaseAdminAuth, getFirebaseAdminFirestore }, { createUserWithEmailAndPassword, signOut }] = await Promise.all([
    import("@/infrastructure/firebase/client"),
    import("@/infrastructure/firebase/admin"),
    import("firebase/auth"),
  ]);
  adminAuth = getFirebaseAdminAuth();
  adminDb = getFirebaseAdminFirestore();
  const email = `sw018a-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(await getFirebaseAuth(), email, "Emulator-Session-Signout-42!");
  const uid = credential.user.uid;
  await Promise.all([
    adminDb.collection("users").doc(uid).set({ uid, email, accountState: "active" }),
    adminDb.collection("userAccess").doc(uid).set({ uid, role: "customer", state: "active" }),
  ]);
  const idToken = await credential.user.getIdToken();
  const cookie = await adminAuth.createSessionCookie(idToken, { expiresIn: 300_000 });
  await signOut(await getFirebaseAuth());
  const result = { uid, cookie };
  fixtures.push(result);
  operationIds.add(sessionSignOutOperationId(cookie));
  return result;
}

function adapter(options: { fail?: () => boolean; entered?: () => void; gate?: Promise<void> } = {}) {
  assert.ok(adminAuth);
  let calls = 0;
  return {
    get calls() { return calls; },
    async revokeRefreshTokens(uid: string) {
      calls += 1;
      options.entered?.();
      if (options.gate) await options.gate;
      if (options.fail?.()) throw Object.assign(new Error("private auth detail"), { code: "auth/network-request-failed" });
      return adminAuth.revokeRefreshTokens(uid);
    },
  } satisfies Pick<Auth, "revokeRefreshTokens"> & { readonly calls: number };
}

function coordinator(auth: Pick<Auth, "revokeRefreshTokens">, extra: {
  stageAudit?: (transaction: Transaction, reference: DocumentReference, record: PreparedAuditEvent) => void;
  now?: () => number;
  processingLeaseMs?: number;
} = {}) {
  assert.ok(adminDb);
  return createSessionSignOutCoordinator({ db: adminDb, auth, retryBaseMs: 1, ...extra });
}

async function begin(target: Fixture, runner = coordinator(adapter())) {
  const claims = await adminAuth.verifySessionCookie(target.cookie, false);
  const operationId = sessionSignOutOperationId(target.cookie);
  operationIds.add(operationId);
  await runner.begin({ operationId, uid: target.uid, authTime: Number(claims.auth_time), actorRole: "customer" });
  return operationId;
}

function routeRequest(cookie?: string, origin = "http://localhost:3000", operationId?: string) {
  return new NextRequest("http://localhost:3000/api/auth/session", {
    method: "DELETE",
    headers: {
      origin,
      ...(cookie ? { cookie: `homegrid_session=${cookie}` } : {}),
      ...(operationId ? { "content-type": "application/json" } : {}),
    },
    ...(operationId ? { body: JSON.stringify({ operationId }) } : {}),
  });
}

async function events(operationId: string, action?: string) {
  const snapshot = await adminDb.collection("auditEvents").where("resourceId", "==", operationId).get();
  return snapshot.docs.filter((doc) => !action || doc.data().action === action);
}

async function makeRetryDue(operationId: string) {
  await adminDb.collection("sessionSignOutOperations").doc(operationId).update({ nextAttemptAt: new Date(0) });
}

test("SW-01.8A durable sign-out intent, revocation and audit recovery", async (t) => {
  const firebaseAdmin = await import("@/infrastructure/firebase/admin");
  adminAuth = firebaseAdmin.getFirebaseAdminAuth();
  adminDb = firebaseAdmin.getFirebaseAdminFirestore();

  await t.test("successful sign-out atomically completes and revokes the session", async () => {
    const target = await fixture();
    const route = await import("@/app/api/auth/session/route");
    const response = await route.DELETE(routeRequest(target.cookie));
    const operationId = sessionSignOutOperationId(target.cookie);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.cookies.get("homegrid_session")?.value, "");
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(operationId).get()).data()?.status, "completed");
    assert.equal((await events(operationId, "auth.session.sign_out.requested")).length, 1);
    assert.equal((await events(operationId, "auth.session.ended")).length, 1);
    await assert.rejects(adminAuth.verifySessionCookie(target.cookie, true));
  });

  await t.test("intent transaction failure calls no Auth operation", async () => {
    const target = await fixture();
    const id = sessionSignOutOperationId(target.cookie);
    let calls = 0;
    const { stagePreparedAuditEvent } = await import("@/services/audit/server-audit");
    const runner = coordinator({ async revokeRefreshTokens() { calls += 1; } }, {
      stageAudit(transaction, reference, record) {
        if (record.action === "auth.session.sign_out.requested") throw new Error("injected intent failure");
        stagePreparedAuditEvent(transaction, reference, record);
      },
    });
    const claims = await adminAuth.verifySessionCookie(target.cookie, false);
    await assert.rejects(runner.begin({ operationId: id, uid: target.uid, authTime: Number(claims.auth_time), actorRole: "customer" }), /injected intent failure/);
    assert.equal(calls, 0);
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(id).get()).exists, false);
    assert.equal((await events(id, "auth.session.sign_out.requested")).length, 0);
  });

  await t.test("Auth revocation failure is sanitized, durable and retryable", async () => {
    const target = await fixture();
    let fail = true;
    const auth = adapter({ fail: () => fail });
    const runner = coordinator(auth);
    const id = await begin(target, runner);
    const failed = await runner.process(id);
    assert.equal(failed.status, "pending");
    assert.equal(failed.lastFailureCode, "auth/network-request-failed");
    const stored = (await adminDb.collection("sessionSignOutOperations").doc(id).get()).data();
    assert.equal(stored?.lastFailurePhase, "auth-revocation");
    assert.equal(JSON.stringify(stored).includes(target.cookie), false);
    assert.equal(JSON.stringify(stored).includes("private auth detail"), false);
    assert.equal((await events(id, "auth.session.sign_out.revocation-failed")).length, 1);
    await makeRetryDue(id);
    fail = false;
    assert.equal((await runner.process(id)).status, "completed");
    await assert.rejects(adminAuth.verifySessionCookie(target.cookie, true));
  });

  await t.test("client-held opaque operation ID resumes after the cookie has been cleared", async () => {
    const target = await fixture();
    let fail = true;
    const runner = coordinator(adapter({ fail: () => fail }));
    const id = await begin(target, runner);
    assert.equal((await runner.process(id)).status, "pending");
    await makeRetryDue(id);
    fail = false;
    const route = await import("@/app/api/auth/session/route");
    const response = await route.DELETE(routeRequest(undefined, "http://localhost:3000", id));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(id).get()).data()?.status, "completed");
    await assert.rejects(adminAuth.verifySessionCookie(target.cookie, true));
  });

  await t.test("revocation followed by completion audit failure is recovered atomically", async () => {
    const target = await fixture();
    let failCompletion = true;
    const { stagePreparedAuditEvent } = await import("@/services/audit/server-audit");
    const runner = coordinator(adapter(), {
      stageAudit(transaction, reference, record) {
        if (record.action === "auth.session.ended" && failCompletion) throw new Error("injected completion audit failure");
        stagePreparedAuditEvent(transaction, reference, record);
      },
    });
    const id = await begin(target, runner);
    assert.equal((await runner.process(id)).status, "pending");
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(id).get()).data()?.lastFailurePhase, "firestore-finalization");
    assert.equal((await events(id, "auth.session.ended")).length, 0);
    assert.equal((await events(id, "auth.session.sign_out.finalization-failed")).length, 1);
    await assert.rejects(adminAuth.verifySessionCookie(target.cookie, true));
    failCompletion = false;
    await makeRetryDue(id);
    assert.equal((await runner.process(id)).status, "completed");
    assert.equal((await events(id, "auth.session.ended")).length, 1);
  });

  await t.test("expired processor lease recovers after interruption", async () => {
    const target = await fixture();
    const runner = coordinator(adapter());
    const id = await begin(target, runner);
    await adminDb.collection("sessionSignOutOperations").doc(id).update({ status: "processing", leaseToken: "abandoned", leaseExpiresAt: new Date(0), nextAttemptAt: new Date(0) });
    const recovered = await runner.processPending();
    assert.equal(recovered.completedOperations, 1);
    assert.equal((await events(id, "auth.session.ended")).length, 1);
  });

  await t.test("repeated processing and duplicate DELETE do not duplicate logical completion", async () => {
    const target = await fixture();
    const runner = coordinator(adapter());
    const id = await begin(target, runner);
    assert.equal((await runner.process(id)).status, "completed");
    assert.equal((await runner.process(id)).status, "completed");
    const route = await import("@/app/api/auth/session/route");
    const duplicate = await route.DELETE(routeRequest(target.cookie));
    assert.equal(duplicate.status, 200);
    assert.equal((await events(id, "auth.session.sign_out.requested")).length, 1);
    assert.equal((await events(id, "auth.session.ended")).length, 1);
  });

  await t.test("concurrent processors are fenced by the active lease", async () => {
    const target = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const auth = adapter({ gate, entered });
    const runner = coordinator(auth);
    const id = await begin(target, runner);
    const first = runner.process(id);
    await started;
    const second = await runner.process(id);
    assert.equal(second.status, "processing");
    assert.equal(auth.calls, 1);
    release();
    assert.equal((await first).status, "completed");
    assert.equal((await events(id, "auth.session.ended")).length, 1);
  });

  await t.test("heartbeat renews the active lease during a long Auth call", async () => {
    const target = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const auth = adapter({ gate, entered });
    const runner = coordinator(auth, { processingLeaseMs: 600 });
    const id = await begin(target, runner);
    const first = runner.process(id);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const op = (await adminDb.collection("sessionSignOutOperations").doc(id).get()).data()!;
    assert.ok((op.leaseExpiresAt as Timestamp).toMillis() > Date.now() + 300);
    assert.equal((await runner.process(id)).status, "processing");
    assert.equal(auth.calls, 1);
    release();
    assert.equal((await first).status, "completed");
  });

  await t.test("invalid cookies clear locally without creating an operation", async () => {
    const route = await import("@/app/api/auth/session/route");
    const bad = `invalid-${randomUUID()}`;
    const response = await route.DELETE(routeRequest(bad));
    assert.equal(response.status, 200);
    assert.equal(response.cookies.get("homegrid_session")?.value, "");
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(sessionSignOutOperationId(bad)).get()).exists, false);
  });

  await t.test("wrong-origin sign-out is rejected and no-cookie sign-out only clears local state", async () => {
    const route = await import("@/app/api/auth/session/route");
    assert.equal((await route.DELETE(routeRequest(undefined, "https://attacker.example"))).status, 403);
    const noCookie = await route.DELETE(routeRequest());
    assert.equal(noCookie.status, 200);
    assert.equal(noCookie.cookies.get("homegrid_session")?.value, "");
  });

  await t.test("a pending sign-out operation denies the matching live session", async () => {
    const target = await fixture();
    const runner = coordinator(adapter());
    const id = await begin(target, runner);
    const { requireAuthenticatedUser } = await import("@/services/auth/authorization");
    await assert.rejects(requireAuthenticatedUser(target.cookie), { code: "unauthenticated" });
    assert.equal((await adminDb.collection("sessionSignOutOperations").doc(id).get()).data()?.status, "pending");
  });

  await t.test("operation records contain no raw cookies, ID tokens or credentials", async () => {
    const target = await fixture();
    const id = await begin(target);
    const stored = (await adminDb.collection("sessionSignOutOperations").doc(id).get()).data();
    const serialized = JSON.stringify(stored);
    assert.notEqual(id, target.cookie);
    assert.equal(serialized.includes(target.cookie), false);
    assert.equal(/idToken|refreshToken|sessionCookie|credential|password/i.test(serialized), false);
  });
});

after(async () => {
  if (!adminAuth || !adminDb) return;
  for (const id of operationIds) await adminDb.collection("sessionSignOutOperations").doc(id).delete().catch(() => undefined);
  for (const target of fixtures) {
    const records = await adminDb.collection("auditEvents").where("actorUid", "==", target.uid).get();
    for (const record of records.docs) await record.ref.delete().catch(() => undefined);
    await adminDb.collection("users").doc(target.uid).delete().catch(() => undefined);
    await adminDb.collection("userAccess").doc(target.uid).delete().catch(() => undefined);
    await adminAuth.deleteUser(target.uid).catch(() => undefined);
  }
  const { getApps, deleteApp } = await import("firebase/app");
  await Promise.all(getApps().map((app) => deleteApp(app)));
  const { getApps: getAdminApps, deleteApp: deleteAdminApp } = await import("firebase-admin/app");
  await Promise.all(getAdminApps().map((app) => deleteAdminApp(app)));
});
