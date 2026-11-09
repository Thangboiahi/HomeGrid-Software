import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeviceDocument, validateDeviceAssociations, validateDeviceDocument } from "@/validation/device";

const legacyDevice = {
  productDefinitionId: "product-v1",
  kind: "simulated",
  state: "assigned",
  householdId: "household-a",
  createdAt: { seconds: 1_700_000_000, nanoseconds: 0 },
  updatedAt: { seconds: 1_700_000_001, nanoseconds: 0 },
};

test("accepts valid simulated and physical registry records", () => {
  assert.equal(isDeviceDocument(legacyDevice), true);
  assert.equal(isDeviceDocument({ ...legacyDevice, kind: "physical", state: "unassigned", householdId: undefined }), true);
});

test("rejects missing required fields, invalid kinds, and unknown lifecycle states", () => {
  assert.ok(validateDeviceDocument({ ...legacyDevice, productDefinitionId: " " }).some((issue) => issue.field === "productDefinitionId"));
  assert.ok(validateDeviceDocument({ ...legacyDevice, kind: "unknown" }).some((issue) => issue.field === "kind"));
  assert.ok(validateDeviceDocument({ ...legacyDevice, state: "online" }).some((issue) => issue.field === "state"));
  assert.ok(validateDeviceDocument({ ...legacyDevice, createdAt: undefined }).some((issue) => issue.field === "createdAt"));
});

test("accepts independent household or installation associations and matching combined associations", () => {
  assert.deepEqual(validateDeviceAssociations({ householdId: "h-1" }), []);
  assert.deepEqual(validateDeviceAssociations({ installationId: "i-1" }), []);
  assert.deepEqual(validateDeviceAssociations({ householdId: "h-1", installationId: "i-1", installationHouseholdId: "h-1" }), []);
});

test("rejects empty and conflicting association combinations", () => {
  assert.notEqual(validateDeviceAssociations({ householdId: "", installationId: "i-1" }).length, 0);
  assert.notEqual(validateDeviceAssociations({ householdId: "h-1", installationId: "i-1", installationHouseholdId: "h-2" }).length, 0);
});

test("preserves the existing persisted shape with optional associations and no hardware identity", () => {
  const existingShape = { ...legacyDevice };
  assert.deepEqual(validateDeviceDocument(existingShape), []);
  assert.equal("hardwareId" in existingShape, false);
  assert.equal("serialNumber" in existingShape, false);
  assert.equal("connectivityState" in existingShape, false);
});
