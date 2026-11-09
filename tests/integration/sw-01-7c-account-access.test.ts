import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { AuthenticatedPrincipal } from "@/services/auth/authorization";
import { createAccountAccessCoordinator } from "@/services/security/account-access-operations";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") throw new Error("Account access emulator tests cannot run in production.");
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:sw-01-7c-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type Role = "customer" | "installer" | "superAdmin";
type FixtureUser = { uid: string; email: string; cookie: string; role: Role };
const fixtures: FixtureUser[] = [];
let adminAuth: Auth | undefined;
let adminDb: Firestore | undefined;

async function createFixtureUser(role: Role): Promise<FixtureUser> {
  const [{ getFirebaseAuth }, { getFirebaseAdminAuth, getFirebaseAdminFirestore }, { createUserWithEmailAndPassword }] = await Promise.all([
    import("@/infrastructure/firebase/client"),
    import("@/infrastructure/firebase/admin"),
    import("firebase/auth"),
  ]);
  const email = `sw017c-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(await getFirebaseAuth(), email, "Emulator-Account-Access-42!");
  const uid = credential.user.uid;
  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminFirestore();
  const now = new Date();
  await Promise.all([
    db.collection("users").doc(uid).set({ uid, email, accountState: "active", createdAt: now, updatedAt: now }),
    db.collection("userAccess").doc(uid).set({ uid, role, state: "active", createdAt: now, updatedAt: now }),
    ...(role === "customer" ? [db.collection("customers").doc(uid).set({ primaryUid: uid, state: "active", createdAt: now, updatedAt: now })] : []),
    ...(role === "installer" ? [db.collection("installers").doc(uid).set({ uid, state: "active", createdAt: now, updatedAt: now })] : []),
  ]);
  const cookie = await auth.createSessionCookie(await credential.user.getIdToken(), { expiresIn: 300_000 });
  const fixture = { uid, email, cookie, role };
  fixtures.push(fixture);
  return fixture;
}

function principal(user: FixtureUser): Pick<AuthenticatedPrincipal, "uid" | "role"> {
  return { uid: user.uid, role: user.role };
}

function authAdapter(options: { failDisable?: () => boolean; failEnable?: () => boolean; failRevoke?: () => boolean } = {}) {
  assert.ok(adminAuth);
  const calls: string[] = [];
  const adapter = {
    async getUser(uid: string) { return adminAuth!.getUser(uid); },
    async updateUser(uid: string, properties: Parameters<Auth["updateUser"]>[1]) {
      calls.push(properties.disabled ? "disable" : "enable");
      if (properties.disabled && options.failDisable?.()) throw Object.assign(new Error("private detail"), { code: "auth/network-request-failed" });
      if (properties.disabled === false && options.failEnable?.()) throw Object.assign(new Error("private detail"), { code: "auth/network-request-failed" });
      return adminAuth!.updateUser(uid, properties);
    },
    async revokeRefreshTokens(uid: string) {
      calls.push("revoke");
      if (options.failRevoke?.()) throw Object.assign(new Error("private detail"), { code: "auth/network-request-failed" });
      return adminAuth!.revokeRefreshTokens(uid);
    },
  } satisfies Pick<Auth, "getUser" | "updateUser" | "revokeRefreshTokens">;
  return { adapter, calls };
}

function makeCoordinator(auth: Pick<Auth, "getUser" | "updateUser" | "revokeRefreshTokens">, extras: { stageAudit?: (transaction: import("firebase-admin/firestore").Transaction, reference: import("firebase-admin/firestore").DocumentReference, record: import("@/services/audit/server-audit").PreparedAuditEvent) => void } = {}) {
  assert.ok(adminDb);
  return createAccountAccessCoordinator({ db: adminDb, auth, retryBaseMs: 1, ...extras });
}

function request(url: string, user: FixtureUser, body?: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { cookie: `homegrid_session=${user.cookie}`, origin: "http://localhost:3000", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function auditEvents(uid: string, action: string) {
  assert.ok(adminDb);
  const events = await adminDb.collection("auditEvents").where("resourceId", "==", uid).get();
  return events.docs.filter((event) => event.data().action === action);
}

async function makeRetryDue(uid: string) {
  assert.ok(adminDb);
  await adminDb.collection("accountAccessOperations").doc(uid).update({ nextAttemptAt: new Date(0) });
}

test("SW-01.7C account suspension and reactivation stay fail-closed across Auth and Firestore", async (t) => {
  const admin = await import("@/infrastructure/firebase/admin");
  adminAuth = admin.getFirebaseAdminAuth();
  adminDb = admin.getFirebaseAdminFirestore();
  const superAdmin = await createFixtureUser("superAdmin");

  await t.test("intent transaction failure calls no Firebase Auth operation and preserves active access", async () => {
    const target = await createFixtureUser("customer");
    const { adapter, calls } = authAdapter();
    const { stagePreparedAuditEvent } = await import("@/services/audit/server-audit");
    const coordinator = makeCoordinator(adapter, {
      stageAudit(transaction, reference, record) {
        if (record.action === "accounts.suspension.requested") throw new Error("Injected intent audit failure.");
        stagePreparedAuditEvent(transaction, reference, record);
      },
    });
    await assert.rejects(coordinator.request(target.uid, "suspend", principal(superAdmin)), /Injected intent audit failure/);
    assert.deepEqual(calls, []);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "active");
    assert.equal((await adminDb!.collection("users").doc(target.uid).get()).data()?.accountState, "active");
    assert.equal((await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).exists, false);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.requested")).length, 0);
  });

  await t.test("successful suspension disables Auth, revokes refresh tokens, and is idempotent", async () => {
    const target = await createFixtureUser("customer");
    const { adapter, calls } = authAdapter();
    const coordinator = makeCoordinator(adapter);
    const result = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["disable", "revoke"]);
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, true);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb!.collection("users").doc(target.uid).get()).data()?.accountState, "disabled");
    const requestEvents = await auditEvents(target.uid, "accounts.suspension.requested");
    const completionEvents = await auditEvents(target.uid, "accounts.suspended");
    assert.equal(requestEvents.length, 1);
    assert.equal(completionEvents.length, 1);
    assert.equal(completionEvents[0].data().executor, "system");
    assert.equal(completionEvents[0].data().correlationId, requestEvents[0].data().correlationId);
    const repeated = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(repeated.operationId, result.operationId);
    assert.deepEqual(calls, ["disable", "revoke"]);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.requested")).length, 1);
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
    const { requireAuthenticatedUser } = await import("@/services/auth/authorization");
    await assert.rejects(requireAuthenticatedUser(target.cookie), (error: unknown) =>
      error instanceof Error && "code" in error && (error.code === "forbidden" || error.code === "unauthenticated"));
  });

  await t.test("authorization denies immediately when Auth disable fails, and retry completes the same operation", async () => {
    const target = await createFixtureUser("installer");
    let fail = true;
    const { adapter, calls } = authAdapter({ failDisable: () => fail });
    const coordinator = makeCoordinator(adapter);
    const pending = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(pending.status, "pending");
    assert.equal(pending.lastFailureCode, "auth/network-request-failed");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, false);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).data()?.status, "pending");
    const { requireAuthenticatedUser } = await import("@/services/auth/authorization");
    await assert.rejects(requireAuthenticatedUser(target.cookie), { code: "forbidden" });
    const duplicate = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(duplicate.operationId, pending.operationId);
    await assert.rejects(coordinator.request(target.uid, "reactivate", principal(superAdmin)), { name: "AccountOperationConflictError" });
    assert.equal((await auditEvents(target.uid, "accounts.suspension.requested")).length, 1);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.auth-update-failed")).length, 2);
    await makeRetryDue(target.uid);
    fail = false;
    const completed = await coordinator.process(target.uid);
    assert.equal(completed.operationId, pending.operationId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(calls, ["disable", "disable", "disable", "revoke"]);
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
  });

  await t.test("refresh-token revocation failure remains pending and can be retried", async () => {
    const target = await createFixtureUser("customer");
    let fail = true;
    const { adapter } = authAdapter({ failRevoke: () => fail });
    const coordinator = makeCoordinator(adapter);
    const pending = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(pending.status, "pending");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, true);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 0);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.token-revocation-failed")).length, 1);
    await makeRetryDue(target.uid);
    fail = false;
    const result = await coordinator.process(target.uid);
    assert.equal(result.status, "completed");
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
  });

  await t.test("expired processing lease recovers after simulated process interruption", async () => {
    const target = await createFixtureUser("customer");
    const { adapter } = authAdapter({ failDisable: () => true });
    const coordinator = makeCoordinator(adapter);
    const pending = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(pending.status, "pending");
    await adminDb!.collection("accountAccessOperations").doc(target.uid).update({
      status: "processing",
      leaseExpiresAt: new Date(0),
      leaseToken: "abandoned-worker",
      nextAttemptAt: new Date(0),
    });
    const { adapter: recoveredAuth } = authAdapter();
    const recovered = await makeCoordinator(recoveredAuth).process(target.uid);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.operationId, pending.operationId);
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
  });

  await t.test("completion audit commit failure leaves suspension pending and retry completes atomically", async () => {
    const target = await createFixtureUser("customer");
    let failCompletionAudit = true;
    const { adapter } = authAdapter();
    const { stagePreparedAuditEvent } = await import("@/services/audit/server-audit");
    const coordinator = makeCoordinator(adapter, {
      stageAudit(transaction, reference, record) {
        if (record.action === "accounts.suspended" && failCompletionAudit) throw new Error("Injected completion audit failure.");
        stagePreparedAuditEvent(transaction, reference, record);
      },
    });
    const pending = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(pending.status, "pending");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, true);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).data()?.status, "pending");
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 0);
    const failedOperation = (await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).data();
    assert.equal(failedOperation?.lastFailurePhase, "firestore-finalization");
    assert.equal(failedOperation?.lastFailureCode, "firestore/operation-failed");
    assert.equal((await auditEvents(target.uid, "accounts.suspension.firestore-finalization-failed")).length, 1);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.auth-update-failed")).length, 0);
    assert.equal((await auditEvents(target.uid, "accounts.suspension.token-revocation-failed")).length, 0);
    await makeRetryDue(target.uid);
    failCompletionAudit = false;
    const completed = await coordinator.process(target.uid);
    assert.equal(completed.status, "completed");
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
  });

  await t.test("reactivation keeps Firestore access denied until Auth enable and token revocation both succeed", async () => {
    const target = await createFixtureUser("customer");
    // Firebase Auth's token-valid-after timestamp is second-granular in the emulator.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { adapter: suspendingAuth } = authAdapter();
    const coordinator = makeCoordinator(suspendingAuth);
    assert.equal((await coordinator.request(target.uid, "suspend", principal(superAdmin))).status, "completed");

    let failRevoke = true;
    const { adapter: reactivatingAuth } = authAdapter({ failRevoke: () => failRevoke });
    const reactivationCoordinator = makeCoordinator(reactivatingAuth);
    const pending = await reactivationCoordinator.request(target.uid, "reactivate", principal(superAdmin));
    assert.equal(pending.status, "pending");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, false);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb!.collection("users").doc(target.uid).get()).data()?.accountState, "disabled");
    const { requireAuthenticatedUser } = await import("@/services/auth/authorization");
    const [{ getFirebaseAuth }, { signInWithEmailAndPassword }] = await Promise.all([
      import("@/infrastructure/firebase/client"),
      import("firebase/auth"),
    ]);
    const signedIn = await signInWithEmailAndPassword(await getFirebaseAuth(), target.email, "Emulator-Account-Access-42!");
    const freshIdToken = await signedIn.user.getIdToken();
    const pendingCookie = await adminAuth!.createSessionCookie(freshIdToken, { expiresIn: 300_000 });
    await assert.rejects(requireAuthenticatedUser(pendingCookie), { code: "forbidden" });

    await makeRetryDue(target.uid);
    failRevoke = false;
    const completed = await reactivationCoordinator.process(target.uid);
    assert.equal(completed.status, "completed");
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "active");
    assert.equal((await adminDb!.collection("users").doc(target.uid).get()).data()?.accountState, "active");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, false);
    assert.equal((await auditEvents(target.uid, "accounts.reactivated")).length, 1);
    await assert.rejects(requireAuthenticatedUser(target.cookie), { code: "unauthenticated" });
  });

  await t.test("failed reactivation enablement leaves Firestore denied", async () => {
    const target = await createFixtureUser("installer");
    const { adapter: suspendingAuth } = authAdapter();
    assert.equal((await makeCoordinator(suspendingAuth).request(target.uid, "suspend", principal(superAdmin))).status, "completed");
    const { adapter } = authAdapter({ failEnable: () => true });
    const result = await makeCoordinator(adapter).request(target.uid, "reactivate", principal(superAdmin));
    assert.equal(result.status, "pending");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, true);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await auditEvents(target.uid, "accounts.reactivated")).length, 0);
  });

  await t.test("unauthorized request routes reject Customer suspension and reactivation", async () => {
    const customer = await createFixtureUser("customer");
    const target = await createFixtureUser("installer");
    const suspensionRoute = await import("@/app/api/admin/accounts/[uid]/suspension/route");
    const reactivationRoute = await import("@/app/api/admin/accounts/[uid]/reactivation/route");
    const context = { params: Promise.resolve({ uid: target.uid }) };
    assert.equal((await suspensionRoute.POST(request("http://localhost/api", customer), context)).status, 403);
    assert.equal((await reactivationRoute.POST(request("http://localhost/api", customer), context)).status, 403);
    assert.equal((await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).exists, false);
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "active");
  });

  await t.test("permanent Auth failures enter manual review; explicit retry is audited", async () => {
    const target = await createFixtureUser("customer");
    const { adapter } = authAdapter();
    let fail = true;
    const original = adapter.updateUser.bind(adapter);
    adapter.updateUser = async (uid, properties) => {
      if (properties.disabled && fail) throw Object.assign(new Error("sensitive"), { code: "auth/user-not-found" });
      return original(uid, properties);
    };
    const coordinator = makeCoordinator(adapter);
    const manual = await coordinator.request(target.uid, "suspend", principal(superAdmin));
    assert.equal(manual.status, "manualReview");
    assert.equal(manual.lastFailureCode, "auth/user-not-found");
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await auditEvents(target.uid, "accounts.suspension.auth-update-failed")).length, 1);
    assert.equal((await coordinator.request(target.uid, "suspend", principal(superAdmin))).status, "manualReview");
    assert.equal((await auditEvents(target.uid, "accounts.suspension.retry-requested")).length, 0);
    const stored = (await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).data();
    assert.equal(stored?.status, "manualReview");
    assert.equal(stored?.lastFailureCode, "auth/user-not-found");
    assert.equal(JSON.stringify(stored).includes("sensitive"), false);
    fail = false;
    const retried = await coordinator.request(target.uid, "suspend", principal(superAdmin), true);
    assert.equal(retried.status, "completed");
    assert.equal((await auditEvents(target.uid, "accounts.suspension.retry-requested")).length, 1);
    assert.equal((await auditEvents(target.uid, "accounts.suspended")).length, 1);
  });

  await t.test("Auth permission failures enter manual review without restoring application access", async () => {
    const target = await createFixtureUser("customer");
    const { adapter } = authAdapter();
    const original = adapter.updateUser.bind(adapter);
    adapter.updateUser = async (uid, properties) => {
      if (properties.disabled) throw Object.assign(new Error("credential details"), { code: "auth/insufficient-permission" });
      return original(uid, properties);
    };
    const result = await makeCoordinator(adapter).request(target.uid, "suspend", principal(superAdmin));
    assert.equal(result.status, "manualReview");
    assert.equal(result.lastFailureCode, "auth/insufficient-permission");
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.state, "suspended");
    assert.equal((await adminDb!.collection("users").doc(target.uid).get()).data()?.accountState, "disabled");
    assert.equal((await adminAuth!.getUser(target.uid)).disabled, false);
    assert.equal(JSON.stringify((await adminDb!.collection("accountAccessOperations").doc(target.uid).get()).data()).includes("credential details"), false);
  });

  await t.test("existing active users remain authorized and duplicate reactivation does not duplicate completion", async () => {
    const target = await createFixtureUser("customer");
    const { requireAuthenticatedUser } = await import("@/services/auth/authorization");
    assert.equal((await requireAuthenticatedUser(target.cookie)).uid, target.uid);
    const { adapter } = authAdapter();
    const coordinator = makeCoordinator(adapter);
    await coordinator.request(target.uid, "suspend", principal(superAdmin));
    const reactivated = await coordinator.request(target.uid, "reactivate", principal(superAdmin));
    assert.equal(reactivated.status, "completed");
    const repeated = await coordinator.request(target.uid, "reactivate", principal(superAdmin));
    assert.equal(repeated.operationId, reactivated.operationId);
    assert.equal((await auditEvents(target.uid, "accounts.reactivated")).length, 1);
  });
});

after(async () => {
  if (!adminAuth || !adminDb) return;
  for (const fixture of fixtures) {
    const audit = await adminDb.collection("auditEvents").where("actorUid", "==", fixture.uid).get();
    if (!audit.empty) {
      const batch = adminDb.batch();
      audit.docs.forEach((event) => batch.delete(event.ref));
      await batch.commit();
    }
    for (const collection of ["users", "userAccess", "customers", "installers", "accountAccessOperations"]) {
      await adminDb.collection(collection).doc(fixture.uid).delete().catch(() => undefined);
    }
    await adminAuth.deleteUser(fixture.uid).catch(() => undefined);
  }
  const { getApps, deleteApp } = await import("firebase/app");
  await Promise.all(getApps().map((app) => deleteApp(app)));
  const { getApps: getAdminApps, deleteApp: deleteAdminApp } = await import("firebase-admin/app");
  await Promise.all(getAdminApps().map((app) => deleteAdminApp(app)));
});
