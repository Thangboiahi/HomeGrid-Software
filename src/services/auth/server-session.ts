import "server-only";

import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import { getFirebaseAdminAuth } from "@/infrastructure/firebase/admin";

export const SESSION_COOKIE_NAME = "homegrid_session";
export const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  };
}

/** Verifies the signed session cookie and revocation state; it grants no role. */
export async function verifyCurrentSession(): Promise<DecodedIdToken | null> {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) return null;

  try {
    return await verifySessionCookie(sessionCookie);
  } catch {
    return null;
  }
}

/** Verifies signature, expiry and revocation for a signed server session cookie. */
export async function verifySessionCookie(sessionCookie: string): Promise<DecodedIdToken> {
  return getFirebaseAdminAuth().verifySessionCookie(sessionCookie, true);
}
