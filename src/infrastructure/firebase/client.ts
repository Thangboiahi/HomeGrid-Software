"use client";

import { getApp, getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  type Auth,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { assertEmulatorEnvironment } from "@/infrastructure/firebase/emulator-environment";

function readRequiredPublicValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required Firebase client configuration: ${name}`);
  }
  return value;
}

function isEmulatorMode(): boolean {
  const authUrl = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL;
  const firestoreHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
  const firestorePort = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT;

  return assertEmulatorEnvironment({
    enabled: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === "true",
    production: process.env.NODE_ENV === "production",
    authHost: authUrl,
    firestoreHost: firestoreHost && firestorePort ? `${firestoreHost}:${firestorePort}` : undefined,
  });
}

function getClientApp() {
  const config: FirebaseOptions = {
    apiKey: readRequiredPublicValue("NEXT_PUBLIC_FIREBASE_API_KEY", process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
    authDomain: readRequiredPublicValue("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    projectId: readRequiredPublicValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID", process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    appId: readRequiredPublicValue("NEXT_PUBLIC_FIREBASE_APP_ID", process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
  };

  if (isEmulatorMode() && !config.projectId?.startsWith("demo-")) {
    throw new Error("Firebase emulator mode requires a demo-* Firebase project ID.");
  }

  const existing = getApps().find((app) => app.name === "[DEFAULT]");
  if (existing) {
    if (existing.options.projectId !== config.projectId) {
      throw new Error("The existing Firebase app uses a different project ID.");
    }
    return getApp();
  }

  return initializeApp(config);
}

let authPromise: Promise<Auth> | undefined;

/** Firebase Auth uses in-memory state; the server session cookie is authoritative. */
export function getFirebaseAuth(): Promise<Auth> {
  if (!authPromise) {
    authPromise = (async () => {
      const app = getClientApp();
      const auth = getAuth(app);
      if (isEmulatorMode()) {
        connectAuthEmulator(auth, process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL!, {
          disableWarnings: true,
        });
      }
      await setPersistence(auth, inMemoryPersistence);
      return auth;
    })().catch((error: unknown) => {
      authPromise = undefined;
      throw error;
    });
  }
  return authPromise;
}

let firestoreClient: Firestore | undefined;

export function getFirebaseFirestore(): Firestore {
  if (!firestoreClient) {
    const app = getClientApp();
    const db = getFirestore(app);
    if (isEmulatorMode()) {
      const host = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST!;
      const port = Number(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT must be a valid TCP port.");
      }
      connectFirestoreEmulator(db, host, port);
    }
    firestoreClient = db;
  }
  return firestoreClient;
}
