import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const projectId = "demo-homegrid";
if (process.env.NODE_ENV === "production") {
  throw new Error("Firebase emulator integration tests must never run in production mode.");
}

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

test("Firebase client and Admin Authentication connect to the Auth Emulator", async () => {
  const { getFirebaseAuth } = await import("@/infrastructure/firebase/client");
  const { getFirebaseAdminAuth } = await import("@/infrastructure/firebase/admin");
  const { createUserWithEmailAndPassword, signOut } = await import("firebase/auth");
  const clientAuth = await getFirebaseAuth();
  const adminAuth = getFirebaseAdminAuth();
  const email = `sw-01-2-auth-${randomUUID()}@example.test`;
  const credential = await createUserWithEmailAndPassword(clientAuth, email, "Emulator-Test-Only-42!");

  try {
    const idToken = await credential.user.getIdToken();
    assert.equal((await adminAuth.verifyIdToken(idToken)).uid, credential.user.uid);
    assert.equal((await adminAuth.getUser(credential.user.uid)).email, email);
    const sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn: 300_000 });
    assert.equal((await adminAuth.verifySessionCookie(sessionCookie)).uid, credential.user.uid);
  } finally {
    await adminAuth.deleteUser(credential.user.uid).catch(() => undefined);
    await signOut(clientAuth);
  }
});

after(async () => {
  const clientAppSdk = await import("firebase/app");
  for (const app of clientAppSdk.getApps()) await clientAppSdk.deleteApp(app);
  const adminAppSdk = await import("firebase-admin/app");
  for (const app of adminAppSdk.getApps()) await adminAppSdk.deleteApp(app);
});
