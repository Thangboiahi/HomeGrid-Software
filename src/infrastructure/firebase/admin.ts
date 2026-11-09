import "server-only";

import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { assertEmulatorEnvironment } from "@/infrastructure/firebase/emulator-environment";

function readProjectId(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is required for Firebase Admin.");
  }
  const publicProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (publicProjectId && publicProjectId !== projectId) {
    throw new Error("Firebase client and Admin project IDs must match.");
  }
  return projectId;
}

function isEmulatorMode(): boolean {
  return assertEmulatorEnvironment({
    enabled: process.env.FIREBASE_USE_EMULATORS === "true",
    production: process.env.NODE_ENV === "production",
    authHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    firestoreHost: process.env.FIRESTORE_EMULATOR_HOST,
  });
}

export function getFirebaseAdminApp(): App {
  const projectId = readProjectId();
  const emulatorsEnabled = isEmulatorMode();

  if (emulatorsEnabled && !projectId.startsWith("demo-")) {
    throw new Error("Firebase emulator mode requires a demo-* Firebase project ID.");
  }

  const existing = getApps().find((app) => app.name === "[DEFAULT]");
  if (existing) {
    if (existing.options.projectId !== projectId) {
      throw new Error("The existing Firebase Admin app uses a different project ID.");
    }
    return existing;
  }

  return initializeApp({
    projectId,
    ...(emulatorsEnabled ? {} : { credential: applicationDefault() }),
  });
}

export function getFirebaseAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getFirebaseAdminFirestore(): Firestore {
  return getFirestore(getFirebaseAdminApp());
}
