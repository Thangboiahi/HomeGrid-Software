"use client";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  type UserCredential,
} from "firebase/auth";
import { getFirebaseAuth } from "@/infrastructure/firebase/client";

async function exchangeForServerSession(credential: UserCredential): Promise<string> {
  const idToken = await credential.user.getIdToken();
  const response = await fetch("/api/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("This account does not currently have HomeGrid access. Contact your administrator.");
    }
    throw new Error("Email or password could not be verified. Please try again.");
  }

  return credential.user.uid;
}

async function completeAuthentication(
  operation: (auth: Awaited<ReturnType<typeof getFirebaseAuth>>) => Promise<UserCredential>,
): Promise<{ uid: string }> {
  const auth = await getFirebaseAuth();
  const credential = await operation(auth);
  try {
    return { uid: await exchangeForServerSession(credential) };
  } finally {
    // Clear browser SDK state; the HttpOnly cookie is the server session.
    await signOut(auth);
  }
}

export function signInWithEmailPassword(email: string, password: string) {
  return completeAuthentication((auth) => signInWithEmailAndPassword(auth, email, password));
}

/** Creates a normal Auth account only; no role or privileged access is assigned. */
export async function registerWithEmailPassword(email: string, password: string): Promise<{ uid: string }> {
  const auth = await getFirebaseAuth();
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    return { uid: credential.user.uid };
  } finally {
    // Registration creates no HomeGrid session; trusted provisioning is required first.
    await signOut(auth);
  }
}

export async function signOutHomeGrid(): Promise<void> {
  const auth = await getFirebaseAuth();
  let response: Response;
  const recoveryKey = "homegrid_signout_operation";
  let operationId: string | null = null;
  try { operationId = window.sessionStorage.getItem(recoveryKey); } catch { /* Storage may be disabled by browser policy. */ }
  try {
    response = await fetch("/api/auth/session", {
      method: "DELETE",
      credentials: "same-origin",
      ...(operationId ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId }),
      } : {}),
    });
  } finally {
    await signOut(auth);
  }
  const result: unknown = await response.json().catch(() => undefined);
  if (typeof result === "object" && result !== null && "operationId" in result && typeof result.operationId === "string") {
    try { window.sessionStorage.setItem(recoveryKey, result.operationId); } catch { /* Server outbox remains recoverable by its trusted processor. */ }
  }
  if (response.status === 404) {
    try { window.sessionStorage.removeItem(recoveryKey); } catch { /* Ignore unavailable browser storage. */ }
  }
  if (!response.ok) throw new Error("Unable to clear the HomeGrid server session.");
  try { window.sessionStorage.removeItem(recoveryKey); } catch { /* Ignore unavailable browser storage. */ }
}
