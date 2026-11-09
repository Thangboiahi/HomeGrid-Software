import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const uid = process.env.HOMEGRID_BOOTSTRAP_UID;
  if (!projectId || !uid) throw new Error("Set FIREBASE_PROJECT_ID and HOMEGRID_BOOTSTRAP_UID for the trusted bootstrap run.");
  if (
    projectId.startsWith("demo-") ||
    process.env.FIREBASE_USE_EMULATORS === "true" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIRESTORE_EMULATOR_HOST
  ) {
    throw new Error("Bootstrap must target the intended trusted Firebase project, not an emulator.");
  }

  const app = getApps()[0] ?? initializeApp({ projectId, credential: applicationDefault() });
  const auth = getAuth(app);
  const target = await auth.getUser(uid);
  if (target.disabled) throw new Error("The bootstrap Auth user must be enabled.");
  const db = getFirestore(app);
  const markerRef = db.collection("system").doc("initialSuperAdminBootstrap");
  const accessRef = db.collection("userAccess").doc(uid);
  const userRef = db.collection("users").doc(uid);
  const existingAdminQuery = db.collection("userAccess").where("role", "==", "superAdmin").limit(1);

  await db.runTransaction(async (transaction) => {
    const [marker, access, existingAdmins] = await Promise.all([
      transaction.get(markerRef),
      transaction.get(accessRef),
      transaction.get(existingAdminQuery),
    ]);
    if (marker.exists) throw new Error("The initial Super Admin bootstrap has already run.");
    if (!existingAdmins.empty) throw new Error("A Super Admin already exists; initial bootstrap is not available.");
    if (access.exists) throw new Error("The selected user already has an application access record.");
    const now = FieldValue.serverTimestamp();
    transaction.create(userRef, {
      uid,
      ...(target.email ? { email: target.email } : {}),
      ...(target.displayName ? { displayName: target.displayName } : {}),
      accountState: "active",
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(accessRef, {
      uid,
      role: "superAdmin",
      state: "active",
      grantedByUid: "trusted-bootstrap",
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(markerRef, { uid, createdAt: now });
    transaction.create(db.collection("auditEvents").doc(), {
      actorUid: "trusted-bootstrap",
      actorRole: "system",
      action: "accounts.bootstrap.superAdmin",
      resourceType: "userAccess",
      resourceId: uid,
      outcome: "success",
      correlationId: randomUUID(),
      occurredAt: now,
    });
  });

  console.log(`Initial HomeGrid Super Admin provisioned for UID ${uid}. Remove HOMEGRID_BOOTSTRAP_UID from the operator environment.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Super Admin bootstrap failed.");
  process.exitCode = 1;
});
