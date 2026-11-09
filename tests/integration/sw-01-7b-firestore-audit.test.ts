import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { createAuditedTransactionRunner, runAuditedTransaction } from "@/services/audit/server-audit";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") {
  throw new Error("Firestore audit consistency tests must never run in production mode.");
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
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:sw-01-7b-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type FixtureUser = { uid: string; email: string; cookie: string };
const users: FixtureUser[] = [];
const productIds: string[] = [];
const firmwareReleaseIds: string[] = [];
const installationIds: string[] = [];
let adminAuth: import("firebase-admin/auth").Auth | undefined;
let adminDb: import("firebase-admin/firestore").Firestore | undefined;
let clientAuth: import("firebase/auth").Auth | undefined;

async function createFixtureUser(): Promise<FixtureUser> {
  const [{ getFirebaseAuth }, { getFirebaseAdminAuth }] = await Promise.all([
    import("@/infrastructure/firebase/client"),
    import("@/infrastructure/firebase/admin"),
  ]);
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  const auth = await getFirebaseAuth();
  clientAuth = auth;
  const email = `sw017b-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(auth, email, "Emulator-Audit-42!");
  const token = await credential.user.getIdToken();
  const user = {
    uid: credential.user.uid,
    email,
    cookie: await getFirebaseAdminAuth().createSessionCookie(token, { expiresIn: 300_000 }),
  };
  users.push(user);
  return user;
}

async function countAuditEvents(resourceId: string, action: string, actorUid?: string): Promise<number> {
  assert.ok(adminDb);
  let query: FirebaseFirestore.Query = adminDb.collection("auditEvents").where("resourceId", "==", resourceId);
  if (actorUid) query = query.where("actorUid", "==", actorUid);
  const result = await query.get();
  return result.docs.filter((doc) => doc.data().action === action && doc.data().outcome === "success").length;
}

test("Firestore privileged mutations commit with exactly one success audit event", async (t) => {
  const [{ getFirebaseAdminAuth, getFirebaseAdminFirestore }, { createProductDefinition, setProductDefinitionState, createFirmwareRelease, setFirmwareReleaseState, assignInstaller, updateAssignedInstallation, provisionAccount }] = await Promise.all([
    import("@/infrastructure/firebase/admin"),
    import("@/services/security/protected-operations"),
  ]);
  adminAuth = getFirebaseAdminAuth();
  adminDb = getFirebaseAdminFirestore();

  const superAdmin = await createFixtureUser();
  const installer = await createFixtureUser();
  const target = await createFixtureUser();
  const now = new Date();
  await Promise.all([
    adminDb.collection("users").doc(superAdmin.uid).set({ uid: superAdmin.uid, email: superAdmin.email, accountState: "active", createdAt: now, updatedAt: now }),
    adminDb.collection("userAccess").doc(superAdmin.uid).set({ uid: superAdmin.uid, role: "superAdmin", state: "active", createdAt: now, updatedAt: now }),
    adminDb.collection("users").doc(installer.uid).set({ uid: installer.uid, email: installer.email, accountState: "active", createdAt: now, updatedAt: now }),
    adminDb.collection("userAccess").doc(installer.uid).set({ uid: installer.uid, role: "installer", state: "active", createdAt: now, updatedAt: now }),
    adminDb.collection("installers").doc(installer.uid).set({ uid: installer.uid, state: "active", createdAt: now, updatedAt: now }),
  ]);

  await t.test("provisioning, product, firmware metadata and installation mutations each audit atomically", async () => {
    const provisioned = await provisionAccount(target.uid, "customer", superAdmin.cookie);
    assert.equal(provisioned.role, "customer");
    assert.equal((await adminDb!.collection("userAccess").doc(target.uid).get()).data()?.role, "customer");
    assert.equal(await countAuditEvents(target.uid, "accounts.provisioned", superAdmin.uid), 1);

    const productCode = `SW17B-${randomUUID().slice(0, 8).toUpperCase()}`;
    const product = await createProductDefinition({ productCode, displayName: "Audit transaction product" }, superAdmin.cookie);
    productIds.push(product.id);
    assert.equal(await countAuditEvents(product.id, "products.created", superAdmin.uid), 1);

    await assert.rejects(setProductDefinitionState(product.id, "retired", superAdmin.cookie), TypeError);
    assert.equal((await adminDb!.collection("productDefinitions").doc(product.id).get()).data()?.state, "draft");
    assert.equal(await countAuditEvents(product.id, "products.state.changed", superAdmin.uid), 0);

    const transitions = await Promise.allSettled([
      setProductDefinitionState(product.id, "active", superAdmin.cookie),
      setProductDefinitionState(product.id, "active", superAdmin.cookie),
    ]);
    assert.equal(transitions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(transitions.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await adminDb!.collection("productDefinitions").doc(product.id).get()).data()?.state, "active");
    assert.equal(await countAuditEvents(product.id, "products.state.changed", superAdmin.uid), 1);

    const release = await createFirmwareRelease({ productDefinitionId: product.id, versionLabel: `test-${randomUUID().slice(0, 8)}` }, superAdmin.cookie);
    firmwareReleaseIds.push(release.id);
    assert.equal(await countAuditEvents(release.id, "firmwareReleases.created", superAdmin.uid), 1);
    await setFirmwareReleaseState(release.id, "approved", superAdmin.cookie);
    assert.equal((await adminDb!.collection("firmwareReleases").doc(release.id).get()).data()?.state, "approved");
    assert.equal(await countAuditEvents(release.id, "firmwareReleases.state.changed", superAdmin.uid), 1);

    const installationId = randomUUID();
    installationIds.push(installationId);
    await adminDb!.collection("installations").doc(installationId).create({ installerUid: "unassigned", customerId: target.uid, state: "scheduled", createdAt: now, updatedAt: now });
    await assignInstaller(installationId, installer.uid, superAdmin.cookie);
    assert.equal(await countAuditEvents(installationId, "installations.assigned", superAdmin.uid), 1);
    await updateAssignedInstallation(installationId, "inProgress", installer.cookie);
    assert.equal(await countAuditEvents(installationId, "installations.progress.update", installer.uid), 1);
    await updateAssignedInstallation(installationId, "completed", installer.cookie, "Verified through emulator test.");
    assert.equal((await adminDb!.collection("installations").doc(installationId).get()).data()?.state, "completed");
    assert.equal(await countAuditEvents(installationId, "installations.complete", installer.uid), 1);
  });

  await t.test("business failure and audit-write failure leave Firestore business data unchanged", async () => {
    const counterRef = adminDb!.collection("__sw017bAuditTests").doc(randomUUID());
    const failureCorrelationId = randomUUID();
    const failAudit = createAuditedTransactionRunner(() => {
      throw new Error("injected audit event write failure");
    });
    await assert.rejects(
      failAudit(adminDb!, {
        actorUid: superAdmin.uid,
        actorRole: "superAdmin",
        action: "test.audit.write.failed",
        resourceType: "test",
        resourceId: counterRef.id,
        outcome: "success",
        correlationId: failureCorrelationId,
      }, async (transaction) => {
        transaction.create(counterRef, { value: 1 });
        return counterRef.id;
      }),
      /injected audit event write failure/,
    );
    assert.equal((await counterRef.get()).exists, false);
    assert.equal(await countAuditEvents(counterRef.id, "test.audit.write.failed", superAdmin.uid), 0);
    const failedAuditQuery = await adminDb!.collection("auditEvents").where("correlationId", "==", failureCorrelationId).get();
    assert.equal(failedAuditQuery.size, 0);

    const occupiedAuditRef = adminDb!.collection("auditEvents").doc();
    await occupiedAuditRef.create({
      actorUid: superAdmin.uid,
      actorRole: "superAdmin",
      action: "test.audit.reserved",
      resourceType: "test",
      resourceId: occupiedAuditRef.id,
      outcome: "success",
      correlationId: randomUUID(),
      occurredAt: new Date(),
    });
    const conflictingAuditDb = {
      collection(name: string) {
        if (name === "auditEvents") return { doc: () => occupiedAuditRef };
        return adminDb!.collection(name);
      },
      runTransaction: adminDb!.runTransaction.bind(adminDb),
    } as unknown as Firestore;
    const commitConflictRef = adminDb!.collection("__sw017bAuditTests").doc(randomUUID());
    await assert.rejects(runAuditedTransaction(conflictingAuditDb, {
      actorUid: superAdmin.uid,
      actorRole: "superAdmin",
      action: "test.audit.commit.conflict",
      resourceType: "test",
      resourceId: commitConflictRef.id,
      outcome: "success",
      correlationId: randomUUID(),
    }, async (transaction) => {
      transaction.create(commitConflictRef, { value: 1 });
      return commitConflictRef.id;
    }));
    assert.equal((await commitConflictRef.get()).exists, false);
    assert.equal((await occupiedAuditRef.get()).data()?.action, "test.audit.reserved");

    await counterRef.create({ value: 4 });
    const businessFailureCorrelationId = randomUUID();
    await assert.rejects(runAuditedTransaction(adminDb!, {
      actorUid: superAdmin.uid,
      actorRole: "superAdmin",
      action: "test.business.mutation.failed",
      resourceType: "test",
      resourceId: counterRef.id,
      outcome: "success",
      correlationId: businessFailureCorrelationId,
    }, async (transaction) => {
      const current = await transaction.get(counterRef);
      transaction.update(counterRef, { value: 99 });
      assert.equal(current.data()?.value, 4);
      throw new TypeError("injected business validation failure");
    }), /injected business validation failure/);
    assert.equal((await counterRef.get()).data()?.value, 4);
    const failedBusinessAudit = await adminDb!.collection("auditEvents").where("correlationId", "==", businessFailureCorrelationId).get();
    assert.equal(failedBusinessAudit.size, 0);
    await counterRef.delete();
  });

  await t.test("transaction retries preserve one logical audit event", async () => {
    const counterRef = { id: randomUUID() } as DocumentReference;
    const correlationId = randomUUID();
    let attempts = 0;
    const attemptsWrites: Array<Array<{ kind: string; ref: unknown; data: Record<string, unknown> }>> = [];
    let committedWrites: Array<{ kind: string; ref: unknown; data: Record<string, unknown> }> = [];
    let transactionAttempts = 0;
    let result = 0;
    const stableAuditRef = { id: "one-stable-audit-document" };
    const retriedDb = {
      collection(name: string) {
        assert.equal(name, "auditEvents");
        return { doc: () => stableAuditRef };
      },
      async runTransaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const writes: Array<{ kind: string; ref: unknown; data: Record<string, unknown> }> = [];
          const transaction = {
            async get() {
              return { exists: true, data: () => ({ value: attempt === 0 ? 0 : 9 }) };
            },
            update(ref: unknown, data: Record<string, unknown>) {
              writes.push({ kind: "update", ref, data });
            },
            create(ref: unknown, data: Record<string, unknown>) {
              writes.push({ kind: "create", ref, data });
            },
          } as unknown as Transaction;
          transactionAttempts += 1;
          result = await callback(transaction) as number;
          attemptsWrites.push(writes);
          if (attempt === 1) committedWrites = writes;
        }
        return result as T;
      },
    };

    const retriedMutation = runAuditedTransaction(retriedDb as unknown as Firestore, {
      actorUid: superAdmin.uid,
      actorRole: "superAdmin",
      action: "test.transaction.retried",
      resourceType: "test",
      resourceId: counterRef.id,
      outcome: "success",
      correlationId,
    }, async (transaction) => {
      const current = await transaction.get(counterRef);
      attempts += 1;
      const value = Number(current.data()?.value ?? 0) + 1;
      transaction.update(counterRef, { value });
      return value;
    });
    await retriedMutation;

    assert.equal(transactionAttempts, 2);
    assert.equal(attempts, 2);
    assert.equal(result, 10);
    assert.equal(attemptsWrites.length, 2);
    assert.equal(attemptsWrites[0].length, 2);
    assert.equal(attemptsWrites[1].length, 2);
    assert.equal(attemptsWrites[0][1].ref, attemptsWrites[1][1].ref);
    assert.equal(attemptsWrites[0][1].data.correlationId, correlationId);
    assert.equal(attemptsWrites[1][1].data.correlationId, correlationId);
    assert.equal(committedWrites.filter((write) => write.kind === "create").length, 1);
    assert.equal(committedWrites.filter((write) => write.kind === "update").length, 1);
  });

  await t.test("unauthorized operation cannot mutate product state or emit a success event", async () => {
    const { setProductDefinitionState } = await import("@/services/security/protected-operations");
    const productId = productIds[0];
    assert.ok(productId);
    await assert.rejects(setProductDefinitionState(productId, "retired", installer.cookie));
    assert.equal((await adminDb!.collection("productDefinitions").doc(productId).get()).data()?.state, "active");
    assert.equal(await countAuditEvents(productId, "products.state.changed", installer.uid), 0);
  });
});

after(async () => {
  if (!adminDb || !adminAuth) return;
  const actorIds = users.map((user) => user.uid);
  for (const actorUid of actorIds) {
    const actorEvents = await adminDb.collection("auditEvents").where("actorUid", "==", actorUid).get();
    if (!actorEvents.empty) {
      const batch = adminDb.batch();
      for (const event of actorEvents.docs) batch.delete(event.ref);
      await batch.commit();
    }
  }
  for (const productId of productIds) await adminDb.collection("productDefinitions").doc(productId).delete().catch(() => undefined);
  for (const releaseId of firmwareReleaseIds) await adminDb.collection("firmwareReleases").doc(releaseId).delete().catch(() => undefined);
  for (const installationId of installationIds) await adminDb.collection("installations").doc(installationId).delete().catch(() => undefined);
  for (const user of users) {
    for (const collection of ["users", "userAccess", "customers", "installers"]) {
      await adminDb.collection(collection).doc(user.uid).delete().catch(() => undefined);
    }
    await adminAuth.deleteUser(user.uid).catch(() => undefined);
  }
  if (clientAuth) {
    const { getApps, deleteApp } = await import("firebase/app");
    await Promise.all(getApps().map((app) => deleteApp(app)));
  }
  const { getApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getApps().map((app) => deleteApp(app)));
});
