import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") throw new Error("Security emulator tests cannot run in production.");
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:homegrid-security-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type Role = "customer" | "installer" | "superAdmin";
type FixtureUser = { uid: string; email: string; cookie: string; token: string; role?: Role };
const fixtureUsers: FixtureUser[] = [];
const fixtureIds: { households: string[]; devices: string[]; installations: string[]; products: string[]; firmwareReleases: string[]; diagnostics: string[] } = {
  households: [], devices: [], installations: [], products: [], firmwareReleases: [], diagnostics: [],
};
let adminAuth: import("firebase-admin/auth").Auth;
let adminDb: import("firebase-admin/firestore").Firestore;
let installerScopedDeviceId: string | undefined;

async function createFixtureUser(role?: Role): Promise<FixtureUser> {
  const { getFirebaseAdminAuth, getFirebaseAdminFirestore } = await import("@/infrastructure/firebase/admin");
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
  const auth = await getFirebaseAuth();
  const email = `sw013-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(auth, email, "Emulator-Security-42!");
  const uid = credential.user.uid;
  const token = await credential.user.getIdToken();
  const cookie = await getFirebaseAdminAuth().createSessionCookie(token, { expiresIn: 300_000 });
  if (role) {
    const now = new Date();
    const db = getFirebaseAdminFirestore();
    await db.collection("users").doc(uid).set({ uid, email, accountState: "active", createdAt: now, updatedAt: now });
    await db.collection("userAccess").doc(uid).set({ uid, role, state: "active", createdAt: now, updatedAt: now });
    if (role === "customer") await db.collection("customers").doc(uid).set({ primaryUid: uid, state: "active", createdAt: now, updatedAt: now });
    if (role === "installer") await db.collection("installers").doc(uid).set({ uid, state: "active", createdAt: now, updatedAt: now });
  }
  const user = { uid, email, token, cookie, role };
  fixtureUsers.push(user);
  return user;
}

function request(url: string, user?: FixtureUser, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      ...(user ? { cookie: `homegrid_session=${user.cookie}` } : {}),
      ...(method !== "GET" ? { origin: "http://localhost:3000" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("SW-01.3 server authorization, isolation, provisioning and audit behavior", async (t) => {
  const admin = await import("@/infrastructure/firebase/admin");
  adminAuth = admin.getFirebaseAdminAuth();
  adminDb = admin.getFirebaseAdminFirestore();
  const customerA = await createFixtureUser("customer");
  const customerB = await createFixtureUser("customer");
  const installerA = await createFixtureUser("installer");
  const installerB = await createFixtureUser("installer");
  const superAdmin = await createFixtureUser("superAdmin");
  const unprovisioned = await createFixtureUser();

  const householdA = randomUUID();
  const householdB = randomUUID();
  fixtureIds.households.push(householdA, householdB);
  await adminDb.collection("households").doc(householdA).set({ displayName: "Test A", memberUids: [customerA.uid], createdByUid: customerA.uid });
  await adminDb.collection("households").doc(householdB).set({ displayName: "Test B", memberUids: [customerB.uid], createdByUid: customerB.uid });

  const productId = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  fixtureIds.products.push(productId);
  fixtureIds.devices.push(deviceA, deviceB);
  await adminDb.collection("productDefinitions").doc(productId).set({ productCode: `TEST-${productId.slice(0, 6)}`, displayName: "Emulator Test", state: "active" });
  await adminDb.collection("devices").doc(deviceA).set({ productDefinitionId: productId, kind: "simulated", state: "assigned", householdId: householdA });
  await adminDb.collection("devices").doc(deviceB).set({ productDefinitionId: productId, kind: "simulated", state: "assigned", householdId: householdB });

  const installationA = randomUUID();
  const installationB = randomUUID();
  fixtureIds.installations.push(installationA, installationB);
  await adminDb.collection("installations").doc(installationA).set({ installerUid: installerA.uid, customerId: customerA.uid, householdId: householdA, state: "scheduled" });
  await adminDb.collection("installations").doc(installationB).set({ installerUid: installerB.uid, customerId: customerB.uid, householdId: householdB, state: "scheduled" });
  const diagnosticId = randomUUID();
  fixtureIds.diagnostics.push(diagnosticId);
  await adminDb.collection("diagnosticRecords").doc(diagnosticId).set({ source: "application", subjectType: "device", subjectId: deviceA, summary: "Emulator test record", createdAt: new Date() });

  await t.test("customer access is membership-scoped and self role writes are denied", async () => {
    const householdRoute = await import("@/app/api/customer/households/[householdId]/route");
    const devicesRoute = await import("@/app/api/customer/households/[householdId]/devices/route");
    const ownHousehold = await householdRoute.GET(request("http://localhost/api", customerA), { params: Promise.resolve({ householdId: householdA }) });
    assert.equal(ownHousehold.status, 200);
    const otherHousehold = await householdRoute.GET(request("http://localhost/api", customerA), { params: Promise.resolve({ householdId: householdB }) });
    assert.equal(otherHousehold.status, 404);
    const ownDevices = await devicesRoute.GET(request("http://localhost/api", customerA), { params: Promise.resolve({ householdId: householdA }) });
    assert.equal(ownDevices.status, 200);
    assert.deepEqual((await ownDevices.json() as { id: string }[]).map((item) => item.id), [deviceA]);
    const otherDevices = await devicesRoute.GET(request("http://localhost/api", customerA), { params: Promise.resolve({ householdId: householdB }) });
    assert.equal(otherDevices.status, 404);
    const accountRoute = await import("@/app/api/admin/accounts/route");
    assert.equal((await accountRoute.POST(request("http://localhost/api/admin/accounts", customerA, "POST", { uid: customerA.uid, role: "superAdmin" }))).status, 403);
    const deniedAdminRoute = await import("@/app/api/admin/accounts/route");
    assert.equal((await deniedAdminRoute.POST(request("http://localhost/api/admin/accounts", customerA, "POST", { uid: customerB.uid, role: "customer" }))).status, 403);
    const clientWrite = await fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/userAccess/${customerA.uid}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${customerA.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { role: { stringValue: "superAdmin" }, state: { stringValue: "active" } } }),
    });
    assert.equal(clientWrite.status, 403);
  });

  await t.test("unprovisioned and suspended accounts cannot use protected APIs", async () => {
    const householdRoute = await import("@/app/api/customer/households/[householdId]/route");
    assert.equal((await householdRoute.GET(request("http://localhost/api", unprovisioned), { params: Promise.resolve({ householdId: householdA }) })).status, 403);
    const suspensionRoute = await import("@/app/api/admin/accounts/[uid]/suspension/route");
    assert.equal((await suspensionRoute.POST(request("http://localhost/api", superAdmin, "POST"), { params: Promise.resolve({ uid: customerB.uid }) })).status, 200);
    const suspendedResponse = await householdRoute.GET(request("http://localhost/api", customerB), { params: Promise.resolve({ householdId: householdB }) });
    assert.ok(suspendedResponse.status === 401 || suspendedResponse.status === 403);
    const reactivationRoute = await import("@/app/api/admin/accounts/[uid]/reactivation/route");
    assert.equal((await reactivationRoute.POST(request("http://localhost/api", superAdmin, "POST"), { params: Promise.resolve({ uid: customerB.uid }) })).status, 200);
    const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
    const { signInWithEmailAndPassword } = await import("firebase/auth");
    const renewedCredential = await signInWithEmailAndPassword(await getFirebaseAuth(), customerB.email, "Emulator-Security-42!");
    customerB.cookie = await adminAuth.createSessionCookie(await renewedCredential.user.getIdToken(), { expiresIn: 300_000 });

    const revokedCustomer = await createFixtureUser("customer");
    const revokedHousehold = randomUUID();
    fixtureIds.households.push(revokedHousehold);
    await adminDb.collection("households").doc(revokedHousehold).set({ displayName: "Revoked session test", memberUids: [revokedCustomer.uid], createdByUid: revokedCustomer.uid });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await adminAuth.revokeRefreshTokens(revokedCustomer.uid);
    const revokedSession = await householdRoute.GET(request("http://localhost/api", revokedCustomer), { params: Promise.resolve({ householdId: revokedHousehold }) });
    assert.equal(revokedSession.status, 401);
  });

  await t.test("installer access follows assignment and platform routes remain unavailable", async () => {
    const installationRoute = await import("@/app/api/installer/installations/[installationId]/route");
    const assignmentRoute = await import("@/app/api/admin/installations/[installationId]/assignment/route");
    const assigned = await installationRoute.GET(request("http://localhost/api", installerA), { params: Promise.resolve({ installationId: installationA }) });
    assert.equal(assigned.status, 200);
    const unassigned = await installationRoute.GET(request("http://localhost/api", installerA), { params: Promise.resolve({ installationId: installationB }) });
    assert.equal(unassigned.status, 404);
    const selfAssignment = await assignmentRoute.POST(request("http://localhost/api", installerA, "POST", { installerUid: installerA.uid }), { params: Promise.resolve({ installationId: installationA }) });
    assert.equal(selfAssignment.status, 403);
    const adminDiagnostics = await import("@/app/api/admin/diagnostics/route");
    assert.equal((await adminDiagnostics.GET(request("http://localhost/api", installerA))).status, 403);
    const progress = await installationRoute.PATCH(request("http://localhost/api", installerA, "PATCH", { state: "inProgress" }), { params: Promise.resolve({ installationId: installationA }) });
    assert.equal(progress.status, 200);
    const completion = await installationRoute.PATCH(request("http://localhost/api", installerA, "PATCH", { state: "completed" }), { params: Promise.resolve({ installationId: installationA }) });
    assert.equal(completion.status, 400);
    const completed = await installationRoute.PATCH(request("http://localhost/api", installerA, "PATCH", { state: "completed", completionNote: "Installation checks submitted." }), { params: Promise.resolve({ installationId: installationA }) });
    assert.equal(completed.status, 200);
    const diagnosticsRoute = await import("@/app/api/installer/installations/[installationId]/diagnostics/route");
    assert.equal((await diagnosticsRoute.GET(request("http://localhost/api", installerA), { params: Promise.resolve({ installationId: installationA }) })).status, 200);
  });

  await t.test("registry operations validate products, associations, roles, and atomic audits", async () => {
    const { registerDevice, assignDevice, reassignDeviceProduct } = await import("@/services/security/protected-operations");
    const device = await registerDevice({ productDefinitionId: productId, kind: "simulated" }, superAdmin.cookie);
    fixtureIds.devices.push(device.id);
    assert.equal(device.state, "unassigned");
    const stored = await adminDb.collection("devices").doc(device.id).get();
    assert.equal(stored.data()?.kind, "simulated");
    assert.equal("ownerUid" in (stored.data() ?? {}), false);
    const registrationAudit = await adminDb.collection("auditEvents").where("resourceId", "==", device.id).get();
    const registrationEvents = registrationAudit.docs.filter((entry) => entry.data().action === "devices.registered");
    assert.equal(registrationEvents.length, 1);
    assert.equal(registrationEvents[0].data().actorRole, "superAdmin");

    await assert.rejects(registerDevice({ productDefinitionId: "missing-product", kind: "physical" }, superAdmin.cookie), TypeError);
    await adminDb.collection("productDefinitions").doc("sw014b-draft").set({ productCode: "SW014B-DRAFT", displayName: "Draft", state: "draft" });
    fixtureIds.products.push("sw014b-draft");
    await assert.rejects(registerDevice({ productDefinitionId: "sw014b-draft", kind: "physical" }, superAdmin.cookie), TypeError);
    await assert.rejects(registerDevice({ productDefinitionId: productId, kind: "invalid" } as never, superAdmin.cookie), TypeError);
    const { AuthorizationError } = await import("@/services/auth/authorization");
    await assert.rejects(registerDevice({ productDefinitionId: productId, kind: "physical" }, customerA.cookie), (error: unknown) => error instanceof AuthorizationError && error.code === "forbidden");
    await assert.rejects(registerDevice({ productDefinitionId: productId, kind: "physical" }, installerA.cookie), (error: unknown) => error instanceof AuthorizationError && error.code === "forbidden");

    await assignDevice(device.id, { householdId: householdA }, superAdmin.cookie);
    const installationWithoutHousehold = randomUUID();
    fixtureIds.installations.push(installationWithoutHousehold);
    await adminDb.collection("installations").doc(installationWithoutHousehold).set({
      installerUid: installerA.uid, customerId: customerA.uid, state: "scheduled",
    });
    await assert.rejects(assignDevice(device.id, { installationId: installationWithoutHousehold }, superAdmin.cookie), TypeError);
    assert.equal((await adminDb.collection("devices").doc(device.id).get()).data()?.installationId, undefined);
    const rejectedAssociationAudit = await adminDb.collection("auditEvents").where("resourceId", "==", device.id).get();
    assert.equal(rejectedAssociationAudit.docs.some((entry) => entry.data().action === "devices.installation.associated"), false);

    const installationOnly = await registerDevice({ productDefinitionId: productId, kind: "physical" }, superAdmin.cookie);
    fixtureIds.devices.push(installationOnly.id);
    installerScopedDeviceId = installationOnly.id;
    await assignDevice(installationOnly.id, { installationId: installationA }, superAdmin.cookie);
    assert.equal((await adminDb.collection("devices").doc(installationOnly.id).get()).data()?.householdId, undefined);
    const combined = await registerDevice({ productDefinitionId: productId, kind: "simulated" }, superAdmin.cookie);
    fixtureIds.devices.push(combined.id);
    await assignDevice(combined.id, { householdId: householdA, installationId: installationA }, superAdmin.cookie);
    await assert.rejects(assignDevice(combined.id, { householdId: householdB, installationId: installationA }, superAdmin.cookie), TypeError);
    await assert.rejects(assignDevice(combined.id, { householdId: householdB }, superAdmin.cookie), TypeError);
    await assert.rejects(assignDevice(combined.id, { householdId: householdA, installationId: installationA }, superAdmin.cookie), TypeError);
    await assert.rejects(assignDevice(combined.id, { householdId: householdA }, customerA.cookie), (error: unknown) => error instanceof AuthorizationError && error.code === "forbidden");
    await assert.rejects(assignDevice(combined.id, { householdId: householdA }, installerA.cookie), (error: unknown) => error instanceof AuthorizationError && error.code === "forbidden");

    await adminDb.collection("productDefinitions").doc("sw014b-active-two").set({ productCode: "SW014B-ACTIVE-TWO", displayName: "Active Two", state: "active" });
    fixtureIds.products.push("sw014b-active-two");
    await reassignDeviceProduct(combined.id, "sw014b-active-two", superAdmin.cookie);
    assert.equal((await adminDb.collection("devices").doc(combined.id).get()).data()?.productDefinitionId, "sw014b-active-two");
    const associationAudit = await adminDb.collection("auditEvents").where("resourceId", "==", combined.id).get();
    assert.ok(associationAudit.docs.some((entry) => entry.data().action === "devices.associations.updated"));
    assert.ok(associationAudit.docs.some((entry) => entry.data().action === "devices.product.assigned"));

    const failedDeviceRef = adminDb.collection("devices").doc();
    const failedAuditRef = adminDb.collection("auditEvents").doc();
    await assert.rejects(adminDb.runTransaction(async (transaction) => {
      transaction.create(failedDeviceRef, { productDefinitionId: productId, kind: "simulated", state: "unassigned" });
      transaction.create(failedAuditRef, { actorUid: superAdmin.uid, invalid: undefined });
    }));
    assert.equal((await failedDeviceRef.get()).exists, false);
  });

  await t.test("device APIs enforce household and assigned-installation scope independently of the UI", async () => {
    const deviceRoute = await import("@/app/api/devices/[deviceId]/route");
    const unauthenticated = await deviceRoute.GET(request("http://localhost/api"), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(unauthenticated.status, 401);
    const householdDevice = await deviceRoute.GET(request("http://localhost/api", customerA), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(householdDevice.status, 200);
    assert.ok((await householdDevice.json() as { product?: { productCode?: string } }).product?.productCode);
    const foreignDevice = await deviceRoute.GET(request("http://localhost/api", customerB), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(foreignDevice.status, 404);
    assert.ok(installerScopedDeviceId);
    const installerDevice = await deviceRoute.GET(request("http://localhost/api", installerA), { params: Promise.resolve({ deviceId: installerScopedDeviceId }) });
    assert.equal(installerDevice.status, 200);
    const unrelatedInstallerDevice = await deviceRoute.GET(request("http://localhost/api", installerA), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(unrelatedInstallerDevice.status, 404);
    const adminDevice = await deviceRoute.GET(request("http://localhost/api", superAdmin), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(adminDevice.status, 200);

    await adminDb.collection("productDefinitions").doc("sw014c-product").set({ productCode: "SW014C-PRODUCT", displayName: "API product", state: "active" });
    fixtureIds.products.push("sw014c-product");
    const productRoute = await import("@/app/api/admin/devices/[deviceId]/product/route");
    const customerChange = await productRoute.PATCH(request("http://localhost/api", customerA, "PATCH", { productDefinitionId: "sw014c-product", role: "superAdmin", ownerUid: customerA.uid }), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(customerChange.status, 403);
    const installerChange = await productRoute.PATCH(request("http://localhost/api", installerA, "PATCH", { productDefinitionId: "sw014c-product" }), { params: Promise.resolve({ deviceId: installerScopedDeviceId }) });
    assert.equal(installerChange.status, 403);
    const adminChange = await productRoute.PATCH(request("http://localhost/api", superAdmin, "PATCH", { productDefinitionId: "sw014c-product" }), { params: Promise.resolve({ deviceId: deviceA }) });
    assert.equal(adminChange.status, 200);
  });

  await t.test("Super Admin can manage platform metadata and receives no control permission", async () => {
    const productsRoute = await import("@/app/api/admin/products/route");
    const productResponse = await productsRoute.POST(request("http://localhost/api/admin/products", superAdmin, "POST", { productCode: `SW13-${randomUUID().slice(0, 6).toUpperCase()}`, displayName: "Security Suite Product" }));
    assert.equal(productResponse.status, 201);
    const createdProduct = await productResponse.json() as { id: string };
    fixtureIds.products.push(createdProduct.id);
    const productStateRoute = await import("@/app/api/admin/products/[productId]/route");
    assert.equal((await productStateRoute.PATCH(request("http://localhost/api", superAdmin, "PATCH", { state: "active" }), { params: Promise.resolve({ productId: createdProduct.id }) })).status, 200);
    const devicesRoute = await import("@/app/api/admin/devices/route");
    const deviceResponse = await devicesRoute.POST(request("http://localhost/api/admin/devices", superAdmin, "POST", { productDefinitionId: createdProduct.id, kind: "physical" }));
    assert.equal(deviceResponse.status, 201);
    const registeredDevice = await deviceResponse.json() as { id: string };
    fixtureIds.devices.push(registeredDevice.id);
    const deviceAssignmentRoute = await import("@/app/api/admin/devices/[deviceId]/assignment/route");
    assert.equal((await deviceAssignmentRoute.POST(request("http://localhost/api", superAdmin, "POST", { householdId: householdA, installationId: installationA }), { params: Promise.resolve({ deviceId: registeredDevice.id }) })).status, 200);
    const firmwareRoute = await import("@/app/api/admin/firmware-releases/route");
    const firmwareResponse = await firmwareRoute.POST(request("http://localhost/api/admin/firmware-releases", superAdmin, "POST", { productDefinitionId: createdProduct.id, versionLabel: "metadata-only-1" }));
    assert.equal(firmwareResponse.status, 201);
    const release = await firmwareResponse.json() as { id: string };
    fixtureIds.firmwareReleases.push(release.id);
    const firmwareStateRoute = await import("@/app/api/admin/firmware-releases/[releaseId]/route");
    assert.equal((await firmwareStateRoute.PATCH(request("http://localhost/api", superAdmin, "PATCH", { state: "approved" }), { params: Promise.resolve({ releaseId: release.id }) })).status, 200);
    const assignmentRoute = await import("@/app/api/admin/installations/[installationId]/assignment/route");
    assert.equal((await assignmentRoute.POST(request("http://localhost/api", superAdmin, "POST", { installerUid: installerB.uid }), { params: Promise.resolve({ installationId: installationA }) })).status, 200);
    const diagnosticsRoute = await import("@/app/api/admin/diagnostics/route");
    const diagnostics = await diagnosticsRoute.GET(request("http://localhost/api", superAdmin));
    assert.equal(diagnostics.status, 200);
    assert.ok((await diagnostics.json() as { id: string }[]).some((item) => item.id === diagnosticId));
    const auditRoute = await import("@/app/api/admin/audit-events/route");
    const audit = await auditRoute.GET(request("http://localhost/api", superAdmin));
    const events = await audit.json() as { actorRole?: string; correlationId?: string }[];
    assert.equal(audit.status, 200);
    assert.ok(events.some((event) => event.actorRole === "superAdmin" && Boolean(event.correlationId)));

    const { requirePermission, AuthorizationError } = await import("@/services/auth/authorization");
    for (const forbidden of ["appliances.operate", "devices.commands.execute", "appliances.state.write", "householdAutomation.write"] as const) {
      await assert.rejects(requirePermission(forbidden as never, superAdmin.cookie), (error: unknown) => error instanceof AuthorizationError && error.code === "forbidden");
    }
    const householdRoute = await import("@/app/api/customer/households/[householdId]/route");
    assert.equal((await householdRoute.GET(request("http://localhost/api", superAdmin), { params: Promise.resolve({ householdId: householdA }) })).status, 403);
    const accountsRoute = await import("@/app/api/admin/accounts/route");
    assert.equal((await accountsRoute.POST(request("http://localhost/api", superAdmin, "POST", { uid: superAdmin.uid, role: "installer" }))).status, 400);
    assert.equal((await accountsRoute.POST(request("http://localhost/api", superAdmin, "POST", { uid: customerA.uid, role: "installer" }))).status, 400);
    const newlyRegistered = await createFixtureUser();
    assert.equal((await accountsRoute.POST(request("http://localhost/api", superAdmin, "POST", { uid: newlyRegistered.uid, role: "customer" }))).status, 201);
    assert.equal((await adminDb.collection("userAccess").doc(newlyRegistered.uid).get()).data()?.role, "customer");
  });

  await t.test("new Firebase registrations have no role or application access by default", async () => {
    assert.equal((await adminDb.collection("userAccess").doc(unprovisioned.uid).get()).exists, false);
    const accountsRoute = await import("@/app/api/admin/accounts/route");
    assert.equal((await accountsRoute.POST(request("http://localhost/api", installerA, "POST", { uid: unprovisioned.uid, role: "customer" }))).status, 403);
    const selfPromotion = await accountsRoute.POST(request("http://localhost/api", installerA, "POST", { uid: installerA.uid, role: "customer" }));
    assert.equal(selfPromotion.status, 403);
  });
});

after(async () => {
  if (adminDb) {
    for (const collection of ["households", "devices", "installations", "productDefinitions", "firmwareReleases", "diagnosticRecords", "auditEvents", "users", "userAccess", "customers", "installers", "accountAccessOperations"]) {
      const snapshots = await adminDb.collection(collection).get();
      const toDelete = snapshots.docs.filter((document) =>
        fixtureUsers.some((user) => document.id === user.uid || document.data().actorUid === user.uid) ||
        fixtureIds.households.includes(document.id) || fixtureIds.devices.includes(document.id) || fixtureIds.installations.includes(document.id) || fixtureIds.products.includes(document.id) || fixtureIds.firmwareReleases.includes(document.id) || fixtureIds.diagnostics.includes(document.id)
      );
      for (let index = 0; index < toDelete.length; index += 400) {
        const batch = adminDb.batch();
        for (const doc of toDelete.slice(index, index + 400)) batch.delete(doc.ref);
        await batch.commit();
      }
    }
  }
  for (const user of fixtureUsers) await adminAuth?.deleteUser(user.uid).catch(() => undefined);
  const appSdk = await import("firebase/app");
  for (const app of appSdk.getApps()) await appSdk.deleteApp(app);
  const adminApp = await import("firebase-admin/app");
  for (const app of adminApp.getApps()) await adminApp.deleteApp(app);
});
