import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessRole } from "@/domain/firestore/models";
import { PROHIBITED_CAPABILITIES, ROLE_PERMISSIONS, roleCanAccessProhibitedCapability, roleHasPermission } from "@/services/auth/permissions";

test("each role has only explicit non-wildcard permissions", () => {
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS) as [AccessRole, readonly string[]][]) {
    assert.ok(permissions.length > 0);
    assert.equal(new Set(permissions).size, permissions.length);
    assert.ok(permissions.every((permission) => permission.includes(".")));
    assert.equal(permissions.some((permission) => permission.includes("*")), false, `${role} must not receive wildcards`);
  }
  assert.equal(roleHasPermission("customer", "households.read.member"), true);
  assert.equal(roleHasPermission("installer", "installations.read.assigned"), true);
  assert.equal(roleHasPermission("superAdmin", "users.manage"), true);
});

test("Super Admin is excluded from all appliance and household automation capabilities", () => {
  for (const capability of PROHIBITED_CAPABILITIES) {
    for (const role of ["customer", "installer", "superAdmin"] as const) {
      assert.equal(roleCanAccessProhibitedCapability(role, capability), false, `${role} must not receive ${capability}`);
    }
  }
  assert.equal(ROLE_PERMISSIONS.superAdmin.some((permission) => /appliance|automation|command|state\.write/i.test(permission)), false);
});

test("platform and household permissions remain separated", () => {
  assert.equal(roleHasPermission("customer", "users.manage"), false);
  assert.equal(roleHasPermission("installer", "products.manage"), false);
  assert.equal(roleHasPermission("superAdmin", "households.read.member"), false);
  assert.equal(roleHasPermission("superAdmin", "devices.register"), true);
  assert.equal(roleHasPermission("superAdmin", "devices.assign"), true);
});
