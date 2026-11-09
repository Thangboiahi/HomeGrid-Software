import "server-only";

import { AuthorizationError, requirePermission } from "@/services/auth/authorization";
import { getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import {
  assignDevice,
  readRegisteredDevices,
  registerDevice,
  reassignDeviceProduct,
} from "@/services/security/protected-operations";
import {
  validateSimulatedDeviceRequest,
  validateSimulatorAssignment,
  validateSimulatorProductRequest,
} from "@/validation/simulator";
import { assertSimulatorEmulatorsReady } from "@/services/simulator/runtime";

export async function createSimulatedDevice(input: unknown, sessionCookie?: string) {
  await assertSimulatorEmulatorsReady();
  const request = validateSimulatedDeviceRequest(input);
  return registerDevice({ ...request, kind: "simulated" }, sessionCookie);
}

export async function readSimulatedDevices(sessionCookie?: string) {
  await assertSimulatorEmulatorsReady();
  const records = await readRegisteredDevices(sessionCookie);
  return records.filter((record) => (record as { kind?: unknown }).kind === "simulated");
}

export async function associateSimulatedDevice(deviceId: string, input: unknown, sessionCookie?: string) {
  await assertSimulatorEmulatorsReady();
  const target = validateSimulatorAssignment(input);
  await requireSimulatedDevice(deviceId, sessionCookie);
  return assignDevice(deviceId, target, sessionCookie);
}

export async function reassignSimulatedDeviceProduct(deviceId: string, input: unknown, sessionCookie?: string) {
  await assertSimulatorEmulatorsReady();
  const { productDefinitionId } = validateSimulatorProductRequest(input);
  await requireSimulatedDevice(deviceId, sessionCookie);
  return reassignDeviceProduct(deviceId, productDefinitionId, sessionCookie);
}

async function requireSimulatedDevice(deviceId: string, sessionCookie?: string): Promise<void> {
  await requirePermission("devices.read", sessionCookie);
  const snapshot = await getFirebaseAdminFirestore().collection("devices").doc(deviceId).get();
  if (!snapshot.exists || snapshot.data()?.kind !== "simulated") {
    throw new AuthorizationError("not-found", "Simulated device not found.");
  }
}
