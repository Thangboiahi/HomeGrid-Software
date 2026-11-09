import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { SimulatorFixtures } from "../fixtures/simulator-fixtures";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") throw new Error("Simulator emulator tests cannot run in production.");
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  HOMEGRID_SIMULATOR_TEST_CLEANUP: "true",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:homegrid-simulator-tests",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

type TestUser = { uid: string; email: string; cookie: string };
type TestData = {
  users: TestUser[];
  products: string[];
  households: string[];
  installations: string[];
  devices: string[];
};
const data: TestData = { users: [], products: [], households: [], installations: [], devices: [] };
const simulatorFixtures = new SimulatorFixtures();
let adminAuth: import("firebase-admin/auth").Auth;
let adminDb: import("firebase-admin/firestore").Firestore;

async function createUser(role: "customer" | "installer" | "superAdmin"): Promise<TestUser> {
  const { getFirebaseAdminAuth, getFirebaseAdminFirestore } = await import("@/infrastructure/firebase/admin");
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
  const email = `sw015-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(await getFirebaseAuth(), email, "Simulator-Test-42!");
  const token = await credential.user.getIdToken();
  const auth = getFirebaseAdminAuth();
  const uid = credential.user.uid;
  const db = getFirebaseAdminFirestore();
  const now = new Date();
  await db.collection("users").doc(uid).set({ uid, email, accountState: "active", createdAt: now, updatedAt: now });
  await db.collection("userAccess").doc(uid).set({ uid, role, state: "active", createdAt: now, updatedAt: now });
  if (role === "customer") await db.collection("customers").doc(uid).set({ primaryUid: uid, state: "active", createdAt: now, updatedAt: now });
  if (role === "installer") await db.collection("installers").doc(uid).set({ uid, state: "active", createdAt: now, updatedAt: now });
  const user = { uid, email, cookie: await auth.createSessionCookie(token, { expiresIn: 300_000 }) };
  data.users.push(user);
  return user;
}

function request(url: string, user?: TestUser, method = "GET", body?: unknown) {
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

test("SW-01.5 simulator is local-only, role-scoped, auditable and fixture-safe", async () => {
  const { getFirebaseAdminAuth, getFirebaseAdminFirestore } = await import("@/infrastructure/firebase/admin");
  const { createProductDefinition } = await import("@/services/security/protected-operations");
  const { assertSimulatorEmulatorsReady } = await import("@/services/simulator/runtime");
  const { roleCanAccessProhibitedCapability, roleHasPermission } = await import("@/services/auth/permissions");
  adminAuth = getFirebaseAdminAuth();
  adminDb = getFirebaseAdminFirestore();
  await assertSimulatorEmulatorsReady();

  const superAdmin = await createUser("superAdmin");
  const customerA = await createUser("customer");
  const customerB = await createUser("customer");
  const installerA = await createUser("installer");
  const installerB = await createUser("installer");
  const product = await createProductDefinition({ productCode: `SIM-${randomUUID().slice(0, 8).toUpperCase()}`, displayName: "Simulator product" }, superAdmin.cookie);
  const secondProduct = await createProductDefinition({ productCode: `SIM-${randomUUID().slice(0, 8).toUpperCase()}`, displayName: "Second simulator product" }, superAdmin.cookie);
  data.products.push(product.id, secondProduct.id);
  await (await import("@/services/security/protected-operations")).setProductDefinitionState(product.id, "active", superAdmin.cookie);
  await (await import("@/services/security/protected-operations")).setProductDefinitionState(secondProduct.id, "active", superAdmin.cookie);

  const householdA = randomUUID();
  const householdB = randomUUID();
  const installationA = randomUUID();
  const installationB = randomUUID();
  const installationWithoutHousehold = randomUUID();
  data.households.push(householdA, householdB);
  data.installations.push(installationA, installationB, installationWithoutHousehold);
  await adminDb.collection("households").doc(householdA).set({ displayName: "Simulator Household A", memberUids: [customerA.uid], createdByUid: customerA.uid });
  await adminDb.collection("households").doc(householdB).set({ displayName: "Simulator Household B", memberUids: [customerB.uid], createdByUid: customerB.uid });
  await adminDb.collection("installations").doc(installationA).set({ installerUid: installerA.uid, customerId: customerA.uid, householdId: householdA, state: "scheduled" });
  await adminDb.collection("installations").doc(installationB).set({ installerUid: installerB.uid, customerId: customerB.uid, householdId: householdB, state: "scheduled" });
  await adminDb.collection("installations").doc(installationWithoutHousehold).set({ installerUid: installerA.uid, customerId: customerA.uid, state: "scheduled" });

  const devicesRoute = await import("@/app/api/dev/simulator/devices/route");
  const assignmentRoute = await import("@/app/api/dev/simulator/devices/[deviceId]/assignment/route");
  const productRoute = await import("@/app/api/dev/simulator/devices/[deviceId]/product/route");
  const deviceRoute = await import("@/app/api/devices/[deviceId]/route");
  const fixtureDevice = await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", {
    productDefinitionId: product.id, householdId: householdA, installationId: installationA,
  }));
  assert.equal(fixtureDevice.status, 201);
  const simulated = await fixtureDevice.json() as { id: string; kind: string; state: string; productDefinitionId: string; householdId?: string; installationId?: string };
  data.devices.push(simulated.id);
  assert.equal(simulated.kind, "simulated");
  assert.equal(simulated.state, "assigned");
  assert.equal(simulated.householdId, householdA);
  assert.equal(simulated.installationId, installationA);
  const creationAudit = await adminDb.collection("auditEvents").where("resourceId", "==", simulated.id).get();
  assert.ok(creationAudit.docs.some((event) => event.data().action === "devices.registered" && event.data().actorRole === "superAdmin"));

  const customerRead = await deviceRoute.GET(request("http://localhost/api/devices", customerA), { params: Promise.resolve({ deviceId: simulated.id }) });
  assert.equal(customerRead.status, 200);
  const customerForeignRead = await deviceRoute.GET(request("http://localhost/api/devices", customerB), { params: Promise.resolve({ deviceId: simulated.id }) });
  assert.equal(customerForeignRead.status, 404);
  const installerRead = await deviceRoute.GET(request("http://localhost/api/devices", installerA), { params: Promise.resolve({ deviceId: simulated.id }) });
  assert.equal(installerRead.status, 200);
  const installerForeignRead = await deviceRoute.GET(request("http://localhost/api/devices", installerB), { params: Promise.resolve({ deviceId: simulated.id }) });
  assert.equal(installerForeignRead.status, 404);
  assert.equal((await devicesRoute.GET(request("http://localhost/api/dev/simulator/devices", customerA))).status, 403);
  assert.equal((await devicesRoute.GET(request("http://localhost/api/dev/simulator/devices", installerA))).status, 403);

  const { registerDevice: register } = await import("@/services/security/protected-operations");
  const physical = await register({ productDefinitionId: product.id, kind: "physical" }, superAdmin.cookie);
  data.devices.push(physical.id);
  assert.equal((await adminDb.collection("devices").doc(physical.id).get()).data()?.kind, "physical");
  const simulatorList = await devicesRoute.GET(request("http://localhost/api/dev/simulator/devices", superAdmin));
  assert.equal(simulatorList.status, 200);
  const list = await simulatorList.json() as Array<{ id: string; kind: string }>;
  assert.ok(list.some((record) => record.id === simulated.id && record.kind === "simulated"));
  assert.equal(list.some((record) => record.id === physical.id), false);

  const beforeInvalidPhysical = await adminDb.collection("devices").get();
  const accidentalPhysical = await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id, kind: "physical" }));
  assert.equal(accidentalPhysical.status, 400);
  assert.equal((await adminDb.collection("devices").get()).size, beforeInvalidPhysical.size);
  assert.equal((await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: "missing-product" }))).status, 400);
  assert.equal((await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id, householdId: randomUUID() }))).status, 404);
  assert.equal((await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id, householdId: householdB, installationId: installationA }))).status, 400);
  assert.equal((await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id, householdId: householdA, installationId: installationWithoutHousehold }))).status, 400);

  const unassignedResponse = await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id }));
  assert.equal(unassignedResponse.status, 201);
  const unassigned = await unassignedResponse.json() as { id: string; state: string };
  data.devices.push(unassigned.id);
  assert.equal(unassigned.state, "unassigned");
  const associationResponse = await assignmentRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { installationId: installationA }), { params: Promise.resolve({ deviceId: unassigned.id }) });
  assert.equal(associationResponse.status, 200);
  assert.equal((await productRoute.PATCH(request("http://localhost/api/dev/simulator/devices", superAdmin, "PATCH", { productDefinitionId: secondProduct.id }), { params: Promise.resolve({ deviceId: unassigned.id }) })).status, 200);
  const associatedAudit = await adminDb.collection("auditEvents").where("resourceId", "==", unassigned.id).get();
  assert.ok(associatedAudit.docs.some((event) => event.data().action === "devices.installation.associated"));
  assert.ok(associatedAudit.docs.some((event) => event.data().action === "devices.product.assigned"));
  assert.equal((await productRoute.PATCH(request("http://localhost/api/dev/simulator/devices", installerA, "PATCH", { productDefinitionId: product.id }), { params: Promise.resolve({ deviceId: unassigned.id }) })).status, 403);
  assert.equal((await assignmentRoute.POST(request("http://localhost/api/dev/simulator/devices", customerA, "POST", { householdId: householdA }), { params: Promise.resolve({ deviceId: unassigned.id }) })).status, 403);
  assert.equal((await assignmentRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { householdId: householdA, installationId: installationB }), { params: Promise.resolve({ deviceId: unassigned.id }) })).status, 400);
  assert.equal((await assignmentRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { installationId: installationA }), { params: Promise.resolve({ deviceId: physical.id }) })).status, 404);

  const fixture = await simulatorFixtures.create("duplicate-scenario", { productDefinitionId: product.id }, superAdmin.cookie);
  assert.equal(simulatorFixtures.size, 1);
  data.devices.push(fixture.id);
  await assert.rejects(simulatorFixtures.create("duplicate-scenario", { productDefinitionId: product.id }, superAdmin.cookie), TypeError);
  const previousNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    assert.equal((await devicesRoute.GET(request("http://localhost/api/dev/simulator/devices", superAdmin))).status, 404);
    assert.equal((await devicesRoute.POST(request("http://localhost/api/dev/simulator/devices", superAdmin, "POST", { productDefinitionId: product.id }))).status, 404);
    await assert.rejects(simulatorFixtures.cleanup(), /simulator is unavailable/i);
  } finally { Object.assign(process.env, { NODE_ENV: previousNodeEnv }); }
  assert.equal((await adminDb.collection("devices").doc(fixture.id).get()).exists, true);
  await simulatorFixtures.cleanup();
  assert.equal((await adminDb.collection("devices").doc(fixture.id).get()).exists, false);
  assert.equal((await adminDb.collection("auditEvents").where("resourceId", "==", fixture.id).get()).empty, true);

  assert.equal(roleHasPermission("superAdmin", "devices.register"), true);
  for (const capability of ["appliances.operate", "devices.commands.execute", "appliances.state.write", "householdAutomation.write"]) {
    assert.equal(roleCanAccessProhibitedCapability("superAdmin", capability), false);
  }
});

after(async () => {
  if (!adminDb || !adminAuth) return;
  const { assertSimulatorEmulatorsReady } = await import("@/services/simulator/runtime");
  await assertSimulatorEmulatorsReady();
  await simulatorFixtures.cleanup();
  for (const deviceId of data.devices) {
    const audits = await adminDb.collection("auditEvents").where("resourceId", "==", deviceId).get();
    const batch = adminDb.batch();
    batch.delete(adminDb.collection("devices").doc(deviceId));
    for (const audit of audits.docs) batch.delete(audit.ref);
    await batch.commit();
  }
  for (const householdId of data.households) await adminDb.collection("households").doc(householdId).delete();
  for (const installationId of data.installations) await adminDb.collection("installations").doc(installationId).delete();
  for (const productId of data.products) await adminDb.collection("productDefinitions").doc(productId).delete();
  const userIds = data.users.map((user) => user.uid);
  const auditEvents = await adminDb.collection("auditEvents").get();
  for (const audit of auditEvents.docs.filter((entry) => userIds.includes(entry.data().actorUid) || data.products.includes(entry.data().resourceId))) {
    await audit.ref.delete();
  }
  for (const user of data.users) {
    for (const collection of ["users", "userAccess", "customers", "installers"]) {
      await adminDb.collection(collection).doc(user.uid).delete().catch(() => undefined);
    }
  }
  for (const user of data.users) await adminAuth.deleteUser(user.uid).catch(() => undefined);
  const client = await import("firebase/app");
  for (const app of client.getApps()) await client.deleteApp(app);
  const admin = await import("firebase-admin/app");
  for (const app of admin.getApps()) await admin.deleteApp(app);
});
