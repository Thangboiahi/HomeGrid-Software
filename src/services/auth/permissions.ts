import type { AccessRole } from "@/domain/firestore/models";

export const PERMISSIONS = [
  "profile.read.own",
  "households.read.member",
  "devices.read.associated",
  "installations.read.available",
  "installations.read.assigned",
  "installations.progress.update",
  "installations.complete",
  "diagnostics.read.assigned",
  "users.read",
  "users.manage",
  "products.read",
  "products.manage",
  "devices.read",
  "devices.register",
  "devices.assign",
  "installations.read",
  "installations.manage",
  "firmwareReleases.manage",
  "diagnostics.read",
  "diagnostics.manage",
  "auditEvents.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<AccessRole, readonly Permission[]>> = {
  customer: [
    "profile.read.own",
    "households.read.member",
    "devices.read.associated",
    "installations.read.available",
  ],
  installer: [
    "profile.read.own",
    "installations.read.assigned",
    "installations.progress.update",
    "installations.complete",
    "diagnostics.read.assigned",
  ],
  superAdmin: [
    "users.read",
    "users.manage",
    "products.read",
    "products.manage",
    "devices.read",
    "devices.register",
    "devices.assign",
    "installations.read",
    "installations.manage",
    "firmwareReleases.manage",
    "diagnostics.read",
    "diagnostics.manage",
    "auditEvents.read",
  ],
};

/** Capabilities forbidden to every platform administrator by design. */
export const PROHIBITED_CAPABILITIES = [
  "appliances.operate",
  "devices.commands.execute",
  "appliances.state.write",
  "householdAutomation.write",
] as const;

export function roleHasPermission(role: AccessRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function roleCanAccessProhibitedCapability(role: AccessRole, capability: string): boolean {
  return roleHasPermission(role, capability as Permission);
}
