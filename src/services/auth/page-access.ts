import "server-only";

import { redirect } from "next/navigation";
import type { AccessRole } from "@/domain/firestore/models";
import { AuthorizationError, requireAuthenticatedUser, requireRole } from "@/services/auth/authorization";
import type { AuthenticatedPrincipal } from "@/services/auth/authorization";

const ROLE_HOME: Record<AccessRole, string> = {
  customer: "/customer",
  installer: "/installer",
  superAdmin: "/super-admin",
};

export async function enforcePageRole(role: AccessRole): Promise<void> {
  try {
    await requireRole(role);
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === "unauthenticated") redirect("/auth");
    let principal: AuthenticatedPrincipal;
    try {
      principal = await requireAuthenticatedUser();
    } catch {
      redirect("/auth");
    }
    redirect(ROLE_HOME[principal.role]);
  }
}
