import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") throw new Error("Auth workflow tests cannot run in production.");
Object.assign(process.env, {
  APP_ORIGIN: "http://localhost:3000",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:homegrid-auth-workflows",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
});

const users: string[] = [];
let adminAuth: import("firebase-admin/auth").Auth;
let adminDb: import("firebase-admin/firestore").Firestore;

function request(url: string, method = "GET", body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST" || method === "DELETE") headers.origin = process.env.APP_ORIGIN!;
  if (cookie) headers.cookie = `homegrid_session=${cookie}`;
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
  });
}

async function createIdentity(email: string) {
  const { createUserWithEmailAndPassword, signOut } = await import("firebase/auth");
  const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
  const auth = await getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, "Emulator-Auth-42!");
  const uid = credential.user.uid;
  users.push(uid);
  const idToken = await credential.user.getIdToken();
  await signOut(auth);
  return { uid, email, idToken, auth };
}

test("SW-01.6A authentication, registration, role routing and session invalidation", async (t) => {
  const { getFirebaseAdminAuth, getFirebaseAdminFirestore } = await import("@/infrastructure/firebase/admin");
  adminAuth = getFirebaseAdminAuth();
  adminDb = getFirebaseAdminFirestore();
  const sessionRoute = await import("@/app/api/auth/session/route");
  const email = `auth-workflow-${randomUUID()}@example.test`;

  await t.test("public registration creates only an Auth identity and rejects credential errors generically", async () => {
    const { registerWithEmailPassword } = await import("@/services/auth/email-password");
    const identity = await registerWithEmailPassword(email, "Emulator-Auth-42!");
    users.push(identity.uid);
    assert.equal((await adminDb.collection("userAccess").doc(identity.uid).get()).exists, false);
    assert.equal((await adminDb.collection("users").doc(identity.uid).get()).exists, false);
    assert.equal((await sessionRoute.GET(request("http://localhost/api/auth/session"))).status, 401);

    const { signInWithEmailAndPassword } = await import("firebase/auth");
    const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
    await assert.rejects(signInWithEmailAndPassword(await getFirebaseAuth(), email, "incorrect-password"));
    await assert.rejects(signInWithEmailAndPassword(await getFirebaseAuth(), `unknown-${email}`, "incorrect-password"));
  });

  await t.test("session creation rejects missing/inactive access and does not accept a client role", async () => {
    const identity = await createIdentity(`unprovisioned-${email}`);
    const denied = await sessionRoute.POST(request("http://localhost/api/auth/session", "POST", { idToken: identity.idToken, role: "superAdmin" }));
    assert.equal(denied.status, 403);
    assert.equal(denied.cookies.get("homegrid_session"), undefined);

    await adminDb.collection("users").doc(identity.uid).set({ uid: identity.uid, email: identity.email, accountState: "active" });
    await adminDb.collection("userAccess").doc(identity.uid).set({ uid: identity.uid, role: "customer", state: "suspended" });
    const suspended = await sessionRoute.POST(request("http://localhost/api/auth/session", "POST", { idToken: identity.idToken, role: "superAdmin" }));
    assert.equal(suspended.status, 403);
    assert.equal(suspended.cookies.get("homegrid_session"), undefined);
  });

  await t.test("active user receives a secure server-established session and server-derived role destination", async () => {
    const identity = await createIdentity(`customer-${email}`);
    await adminDb.collection("users").doc(identity.uid).set({ uid: identity.uid, email: identity.email, accountState: "active" });
    await adminDb.collection("userAccess").doc(identity.uid).set({ uid: identity.uid, role: "customer", state: "active" });

    const created = await sessionRoute.POST(request("http://localhost/api/auth/session", "POST", { idToken: identity.idToken, role: "superAdmin", permissions: ["appliances.operate"] }));
    assert.equal(created.status, 200, await created.clone().text());
    const setCookie = created.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /homegrid_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=432000/i);
    const sessionCookie = created.cookies.get("homegrid_session")?.value;
    assert.ok(sessionCookie);

    const resolved = await sessionRoute.GET(request("http://localhost/api/auth/session", "GET", undefined, sessionCookie));
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { redirectTo: "/customer" });

    const logout = await sessionRoute.DELETE(request("http://localhost/api/auth/session", "DELETE", undefined, sessionCookie));
    assert.equal(logout.status, 200, await logout.clone().text());
    assert.equal(logout.cookies.get("homegrid_session")?.value, "");
    assert.equal((await sessionRoute.GET(request("http://localhost/api/auth/session", "GET", undefined, sessionCookie))).status, 401);
  });

  await t.test("disabled Auth accounts and missing session cookies cannot establish protected access", async () => {
    assert.equal((await sessionRoute.GET(request("http://localhost/api/auth/session"))).status, 401);
    const identity = await createIdentity(`disabled-${email}`);
    await adminDb.collection("users").doc(identity.uid).set({ uid: identity.uid, email: identity.email, accountState: "active" });
    await adminDb.collection("userAccess").doc(identity.uid).set({ uid: identity.uid, role: "installer", state: "active" });
    await adminAuth.updateUser(identity.uid, { disabled: true });
    const denied = await sessionRoute.POST(request("http://localhost/api/auth/session", "POST", { idToken: identity.idToken }));
    assert.ok(denied.status === 401 || denied.status === 403, await denied.clone().text());
    assert.equal(denied.cookies.get("homegrid_session"), undefined);
  });
});

after(async () => {
  for (const uid of users) await adminAuth?.deleteUser(uid).catch(() => undefined);
  if (adminDb) {
    for (const collection of ["users", "userAccess", "auditEvents"]) {
      const snapshots = await adminDb.collection(collection).get();
      const owned = snapshots.docs.filter((doc) => users.includes(doc.id) || (collection === "auditEvents" && users.includes(String(doc.data().actorUid))));
      for (const doc of owned) await doc.ref.delete();
    }
  }
  const clientApp = await import("firebase/app");
  for (const app of clientApp.getApps()) await clientApp.deleteApp(app);
  const adminApp = await import("firebase-admin/app");
  for (const app of adminApp.getApps()) await adminApp.deleteApp(app);
});
