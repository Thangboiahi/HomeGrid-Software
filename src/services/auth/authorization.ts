import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { AccessRole } from "@/domain/firestore/models";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { verifySessionCookie } from "@/services/auth/server-session";
import { sessionSignOutOperationId } from "@/services/auth/session-signout-operations";
import { roleHasPermission, type Permission } from "@/services/auth/permissions";
import { recordAuditEvent } from "@/services/audit/server-audit";

export type AuthorizationErrorCode = "unauthenticated" | "forbidden" | "not-found";

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationErrorCode, message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AccountOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountOperationConflictError";
  }
}

export type AuthenticatedPrincipal = {
  uid: string;
  email?: string;
  role: AccessRole;
  claims: DecodedIdToken;
};

/** Reads the signed HttpOnly cookie; callers cannot supply a role or permissions. */
export async function requireAuthenticatedUser(sessionCookie?: string): Promise<AuthenticatedPrincipal> {
  const cookie = sessionCookie ?? (await cookies()).get("homegrid_session")?.value;
  if (!cookie) throw new AuthorizationError("unauthenticated", "Authentication required.");

  let claims: DecodedIdToken;
  try {
    claims = await verifySessionCookie(cookie);
  } catch {
    throw new AuthorizationError("unauthenticated", "Authentication required.");
  }

  const db = getFirebaseAdminFirestore();
  const [accessSnapshot, userSnapshot, operationSnapshot, signOutSnapshot] = await Promise.all([
    db.collection("userAccess").doc(claims.uid).get(),
    db.collection("users").doc(claims.uid).get(),
    db.collection("accountAccessOperations").doc(claims.uid).get(),
    db.collection("sessionSignOutOperations").doc(sessionSignOutOperationId(cookie)).get(),
  ]);
  if (signOutSnapshot.exists) throw new AuthorizationError("unauthenticated", "Session is being invalidated.");
  if (!accessSnapshot.exists) throw new AuthorizationError("forbidden", "Application access is not provisioned.");

  const access = accessSnapshot.data();
  if (!access || access.state !== "active" || !isAccessRole(access.role)) {
    throw new AuthorizationError("forbidden", "Account is not active.");
  }
  if (!userSnapshot.exists || userSnapshot.data()?.accountState !== "active") {
    throw new AuthorizationError("forbidden", "Account is not active.");
  }
  if (operationSnapshot.exists) {
    const operation = operationSnapshot.data();
    if (operation?.status !== "completed" || operation?.kind === "suspend" || operation?.kind !== "reactivate") {
      throw new AuthorizationError("forbidden", "Account access operation is incomplete.");
    }
  }

  let authUser;
  try {
    authUser = await getFirebaseAdminAuth().getUser(claims.uid);
  } catch {
    throw new AuthorizationError("unauthenticated", "Authentication required.");
  }
  if (authUser.disabled) throw new AuthorizationError("forbidden", "Account is disabled.");

  return { uid: claims.uid, ...(authUser.email ? { email: authUser.email } : {}), role: access.role, claims };
}

export async function requireActiveAccount(sessionCookie?: string): Promise<AuthenticatedPrincipal> {
  return requireAuthenticatedUser(sessionCookie);
}

export async function requireRole(role: AccessRole, sessionCookie?: string): Promise<AuthenticatedPrincipal> {
  const principal = await requireAuthenticatedUser(sessionCookie);
  if (principal.role !== role) {
    await recordDenied(principal, "authorization.role.denied", "role", role);
    throw new AuthorizationError("forbidden", "Role is not authorized.");
  }
  return principal;
}

export async function requirePermission(permission: Permission, sessionCookie?: string): Promise<AuthenticatedPrincipal> {
  const principal = await requireAuthenticatedUser(sessionCookie);
  if (!roleHasPermission(principal.role, permission)) {
    await recordDenied(principal, "authorization.permission.denied", "permission", permission);
    throw new AuthorizationError("forbidden", "Permission is not granted.");
  }
  return principal;
}

export async function requireHouseholdMembership(
  householdId: string,
  sessionCookie?: string,
): Promise<AuthenticatedPrincipal> {
  const principal = await requirePermission("households.read.member", sessionCookie);
  const household = await getFirebaseAdminFirestore().collection("households").doc(householdId).get();
  if (!household.exists) throw new AuthorizationError("not-found", "Household not found.");
  const memberUids: unknown = household.data()?.memberUids;
  if (!Array.isArray(memberUids) || !memberUids.includes(principal.uid)) {
    await recordDenied(principal, "authorization.household.denied", "household", householdId);
    throw new AuthorizationError("not-found", "Household not found.");
  }
  return principal;
}

export async function requireInstallationAssignment(
  installationId: string,
  sessionCookie?: string,
): Promise<AuthenticatedPrincipal> {
  const principal = await requirePermission("installations.read.assigned", sessionCookie);
  const installation = await getFirebaseAdminFirestore().collection("installations").doc(installationId).get();
  if (!installation.exists || installation.data()?.installerUid !== principal.uid) {
    await recordDenied(principal, "authorization.installation.denied", "installation", installationId);
    throw new AuthorizationError("not-found", "Installation not found.");
  }
  return principal;
}

export async function requireResourceOwnership(
  ownerUid: string,
  householdId?: string,
  sessionCookie?: string,
): Promise<AuthenticatedPrincipal> {
  const principal = await requireAuthenticatedUser(sessionCookie);
  if (principal.uid === ownerUid) return principal;
  if (householdId) return requireHouseholdMembership(householdId, sessionCookie);
  await recordDenied(principal, "authorization.ownership.denied", "user", ownerUid);
  throw new AuthorizationError("not-found", "Resource not found.");
}

function recordDenied(actor: AuthenticatedPrincipal, action: string, resourceType: string, resourceId: string): Promise<void> {
  return recordAuditEvent({
    actorUid: actor.uid,
    actorRole: actor.role,
    action,
    resourceType,
    resourceId,
    outcome: "denied",
    correlationId: randomUUID(),
  });
}

function isAccessRole(value: unknown): value is AccessRole {
  return value === "customer" || value === "installer" || value === "superAdmin";
}
