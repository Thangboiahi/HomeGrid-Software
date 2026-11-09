import assert from "node:assert/strict";
import { test } from "node:test";
import { getSimulatorEnvironment } from "@/domain/simulator/configuration";
import { validateSimulatedDeviceRequest, validateSimulatorAssignment, validateSimulatorProductRequest } from "@/validation/simulator";

const safeEnvironment = {
  NODE_ENV: "test",
  FIREBASE_PROJECT_ID: "demo-homegrid",
  FIREBASE_USE_EMULATORS: "true",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-homegrid",
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8080",
};

test("simulator accepts only matching demo-project loopback emulator configuration", () => {
  assert.deepEqual(getSimulatorEnvironment(safeEnvironment), {
    projectId: "demo-homegrid", authHost: "127.0.0.1", authPort: 9099, firestoreHost: "127.0.0.1", firestorePort: 8080,
  });
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, NODE_ENV: "production" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, FIREBASE_PROJECT_ID: "homegrid-live" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-other" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, FIREBASE_USE_EMULATORS: "false" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, FIRESTORE_EMULATOR_HOST: "prod.example:8080" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "https://127.0.0.1:9099" }), undefined);
  assert.equal(getSimulatorEnvironment({ ...safeEnvironment, NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: "8081" }), undefined);
});

test("simulator creation fixes classification to simulated and validates product and associations", () => {
  assert.deepEqual(validateSimulatedDeviceRequest({ productDefinitionId: "  product-a  ", householdId: "h-a", installationId: "i-a" }), {
    productDefinitionId: "product-a", householdId: "h-a", installationId: "i-a",
  });
  assert.throws(() => validateSimulatedDeviceRequest({ productDefinitionId: "product-a", kind: "physical" }), TypeError);
  assert.throws(() => validateSimulatedDeviceRequest({ productDefinitionId: " " }), TypeError);
  assert.throws(() => validateSimulatedDeviceRequest({ productDefinitionId: "product-a", householdId: " " }), TypeError);
});

test("simulator association and product payloads reject malformed or empty requests", () => {
  assert.deepEqual(validateSimulatorAssignment({ householdId: "h-a" }), { householdId: "h-a" });
  assert.deepEqual(validateSimulatorAssignment({ installationId: "i-a" }), { installationId: "i-a" });
  assert.throws(() => validateSimulatorAssignment({}), TypeError);
  assert.throws(() => validateSimulatorAssignment({ householdId: " " }), TypeError);
  assert.deepEqual(validateSimulatorProductRequest({ productDefinitionId: "p-a" }), { productDefinitionId: "p-a" });
  assert.throws(() => validateSimulatorProductRequest({ productDefinitionId: "" }), TypeError);
});
