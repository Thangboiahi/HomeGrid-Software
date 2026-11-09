import { validateDeviceAssociations } from "@/validation/device";

export type SimulatedDeviceRequest = {
  productDefinitionId: string;
  householdId?: string;
  installationId?: string;
};

export function validateSimulatedDeviceRequest(value: unknown): SimulatedDeviceRequest {
  if (!isRecord(value) || typeof value.productDefinitionId !== "string" || !value.productDefinitionId.trim()) {
    throw new TypeError("An active product definition reference is required.");
  }
  if (value.kind !== undefined && value.kind !== "simulated") {
    throw new TypeError("The simulator can create simulated device records only.");
  }
  const associationInput = {
    ...(value.householdId !== undefined ? { householdId: value.householdId } : {}),
    ...(value.installationId !== undefined ? { installationId: value.installationId } : {}),
  };
  if (validateDeviceAssociations(associationInput).length) throw new TypeError("Invalid device associations.");
  return {
    productDefinitionId: value.productDefinitionId.trim(),
    ...(typeof value.householdId === "string" ? { householdId: value.householdId.trim() } : {}),
    ...(typeof value.installationId === "string" ? { installationId: value.installationId.trim() } : {}),
  };
}

export function validateSimulatorAssignment(value: unknown): { householdId?: string; installationId?: string } {
  if (!isRecord(value)) throw new TypeError("Invalid device associations.");
  const associationInput = {
    ...(value.householdId !== undefined ? { householdId: value.householdId } : {}),
    ...(value.installationId !== undefined ? { installationId: value.installationId } : {}),
  };
  if (!associationInput.householdId && !associationInput.installationId) throw new TypeError("At least one association is required.");
  if (validateDeviceAssociations(associationInput).length) throw new TypeError("Invalid device associations.");
  return {
    ...(typeof value.householdId === "string" ? { householdId: value.householdId.trim() } : {}),
    ...(typeof value.installationId === "string" ? { installationId: value.installationId.trim() } : {}),
  };
}

export function validateSimulatorProductRequest(value: unknown): { productDefinitionId: string } {
  if (!isRecord(value) || typeof value.productDefinitionId !== "string" || !value.productDefinitionId.trim()) {
    throw new TypeError("A product definition reference is required.");
  }
  return { productDefinitionId: value.productDefinitionId.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
