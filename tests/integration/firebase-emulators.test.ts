import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { assertEmulatorEnvironment } from "@/infrastructure/firebase/emulator-environment";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") {
  throw new Error("Firebase emulator integration tests must never run in production mode.");
}
process.env.APP_ORIGIN = "http://localhost:3000";

// Force a safe, local-only configuration even if a developer has other values
// in the shell. These tests never accept a real Firebase project ID or host.
process.env.FIREBASE_PROJECT_ID = projectId;
process.env.FIREBASE_USE_EMULATORS = "true";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = projectId;
process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "demo-api-key";
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = `${projectId}.firebaseapp.com`;
process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "1:123456789:web:homegrid-local";
process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS = "true";
process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL = "http://127.0.0.1:9099";
process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST = "127.0.0.1";
process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT = "8080";

after(async () => {
  const clientAppSdk = await import("firebase/app");
  for (const app of clientAppSdk.getApps()) {
    await clientAppSdk.deleteApp(app);
  }
  const adminAppSdk = await import("firebase-admin/app");
  for (const app of adminAppSdk.getApps()) {
    await adminAppSdk.deleteApp(app);
  }
});

test("emulator configuration is isolated from production", () => {
  assert.throws(() =>
    assertEmulatorEnvironment({
      enabled: true,
      production: true,
      authHost: "127.0.0.1:9099",
      firestoreHost: "127.0.0.1:8080",
    }),
  );
  assert.throws(() =>
    assertEmulatorEnvironment({
      enabled: false,
      production: false,
      authHost: "127.0.0.1:9099",
      firestoreHost: "127.0.0.1:8080",
    }),
  );
  assert.equal(process.env.FIREBASE_PROJECT_ID, projectId);
  assert.ok(projectId.startsWith("demo-"));
});

test("client and Admin SDKs connect to Auth and Firestore emulators", async () => {
  const { getFirebaseAuth, getFirebaseFirestore } = await import("@/infrastructure/firebase/client");
  const { getFirebaseAdminAuth, getFirebaseAdminFirestore } = await import("@/infrastructure/firebase/admin");
  const { createUserWithEmailAndPassword, signOut } = await import("firebase/auth");
  const { NextRequest } = await import("next/server");

  const clientAuth = await getFirebaseAuth();
  getFirebaseFirestore();
  const adminAuth = getFirebaseAdminAuth();
  const adminDb = getFirebaseAdminFirestore();
  const email = `sw-01-2-${randomUUID()}@example.test`;

  const credential = await createUserWithEmailAndPassword(clientAuth, email, "Emulator-Test-Only-42!");
  const uid = credential.user.uid;
  const firestoreRef = adminDb.collection("__integrationTests").doc(randomUUID());
  const userProfileRef = adminDb.collection("users").doc(uid);
  const userAccessRef = adminDb.collection("userAccess").doc(uid);

  try {
    await userProfileRef.set({ uid, email, accountState: "active" });
    await userAccessRef.set({ uid, role: "customer", state: "active" });
    const decodedIdToken = await adminAuth.verifyIdToken(await credential.user.getIdToken());
    assert.equal(decodedIdToken.uid, uid);
    assert.equal((await adminAuth.getUser(uid)).email, email);

    const sessionCookie = await adminAuth.createSessionCookie(await credential.user.getIdToken(), {
      expiresIn: 300_000,
    });
    assert.equal((await adminAuth.verifySessionCookie(sessionCookie)).uid, uid);

    const { POST: createSession } = await import("@/app/api/auth/session/route");
    const idToken = await credential.user.getIdToken();
    const deniedSession = await createSession(
      new NextRequest("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: { origin: "https://attacker.example", "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      }),
    );
    assert.equal(deniedSession.status, 403);

    const issuedSession = await createSession(
      new NextRequest("http://localhost:3000/api/auth/session", {
        method: "POST",
        headers: { origin: process.env.APP_ORIGIN!, "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      }),
    );
    assert.equal(issuedSession.status, 200);
    assert.equal(issuedSession.headers.get("cache-control"), "no-store, max-age=0");
    const cookieHeader = issuedSession.headers.get("set-cookie") ?? "";
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    assert.match(cookieHeader, /Max-Age=432000/i);
    const issuedCookie = issuedSession.cookies.get("homegrid_session")?.value;
    assert.ok(issuedCookie);
    assert.equal((await adminAuth.verifySessionCookie(issuedCookie)).uid, uid);

    const { DELETE: endSession } = await import("@/app/api/auth/session/route");
    const endedSession = await endSession(
      new NextRequest("http://localhost:3000/api/auth/session", {
        method: "DELETE",
        headers: {
          origin: process.env.APP_ORIGIN!,
          cookie: `homegrid_session=${issuedCookie}`,
        },
      }),
    );
    assert.equal(endedSession.status, 200);
    assert.match(endedSession.headers.get("set-cookie") ?? "", /Max-Age=0/i);
    const auditEvents = await adminDb.collection("auditEvents").where("actorUid", "==", uid).get();
    assert.deepEqual(
      auditEvents.docs.map((snapshot) => snapshot.data().action).sort(),
      ["auth.session.created", "auth.session.ended", "auth.session.sign_out.requested"],
    );
    await Promise.all(auditEvents.docs.map((snapshot) => snapshot.ref.delete()));
    const signOutOperations = await adminDb.collection("sessionSignOutOperations").where("uid", "==", uid).get();
    await Promise.all(signOutOperations.docs.map((snapshot) => snapshot.ref.delete()));

    // Client reads remain denied, even for an authenticated emulator user.
    const clientRead = await fetch(
      "http://127.0.0.1:8080/v1/projects/demo-homegrid/databases/(default)/documents/__integrationTests/client-read-denied",
      { headers: { authorization: `Bearer ${await credential.user.getIdToken()}` } },
    );
    assert.equal(clientRead.status, 403);

    // Trusted Admin access reaches the same emulator; Admin bypasses rules.
    await firestoreRef.set({ marker: "sw-01.2-emulator-test" });
    const stored = await firestoreRef.get();
    assert.equal(stored.data()?.marker, "sw-01.2-emulator-test");
  } finally {
    await firestoreRef.delete().catch(() => undefined);
    await userProfileRef.delete().catch(() => undefined);
    await userAccessRef.delete().catch(() => undefined);
    await adminAuth.deleteUser(uid).catch(() => undefined);
    await signOut(clientAuth);
  }
});
