import type { DeviceDocument } from "@/domain/firestore/models";

export type DeviceValidationIssue = {
  field: keyof DeviceDocument | "associations";
  message: string;
};

const DEVICE_STATES = ["unassigned", "assigned", "retired"] as const;
const DEVICE_KINDS = ["simulated", "physical"] as const;

/** Validates the existing persisted document shape without requiring new fields. */
export function validateDeviceDocument(value: unknown): DeviceValidationIssue[] {
  const issues: DeviceValidationIssue[] = [];
  if (!isRecord(value)) return [{ field: "productDefinitionId", message: "Device record must be an object." }];

  if (!isNonEmptyString(value.productDefinitionId)) {
    issues.push({ field: "productDefinitionId", message: "A product definition reference is required." });
  }
  if (!DEVICE_KINDS.includes(value.kind as (typeof DEVICE_KINDS)[number])) {
    issues.push({ field: "kind", message: "Device kind must be simulated or physical." });
  }
  if (!DEVICE_STATES.includes(value.state as (typeof DEVICE_STATES)[number])) {
    issues.push({ field: "state", message: "Unknown device registry lifecycle state." });
  }
  for (const field of ["householdId", "installationId"] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) {
      issues.push({ field, message: `${field} must be a non-empty identifier when provided.` });
    }
  }
  if (!isFirestoreTimestamp(value.createdAt)) {
    issues.push({ field: "createdAt", message: "createdAt must be a Firestore timestamp shape." });
  }
  if (!isFirestoreTimestamp(value.updatedAt)) {
    issues.push({ field: "updatedAt", message: "updatedAt must be a Firestore timestamp shape." });
  }
  return issues;
}

/**
 * Checks an association change against the related installation record.
 * Household and installation links may each exist independently. When both
 * are supplied, the installation must itself reference that household.
 */
export function validateDeviceAssociations(input: {
  householdId?: unknown;
  installationId?: unknown;
  installationHouseholdId?: unknown;
}): DeviceValidationIssue[] {
  const issues: DeviceValidationIssue[] = [];
  if (input.householdId !== undefined && !isNonEmptyString(input.householdId)) {
    issues.push({ field: "householdId", message: "householdId must be a non-empty identifier when provided." });
  }
  if (input.installationId !== undefined && !isNonEmptyString(input.installationId)) {
    issues.push({ field: "installationId", message: "installationId must be a non-empty identifier when provided." });
  }
  if (input.householdId !== undefined && input.installationId !== undefined && input.installationHouseholdId !== undefined &&
      input.installationHouseholdId !== input.householdId) {
    issues.push({ field: "associations", message: "Household and installation associations must refer to the same household." });
  }
  return issues;
}

export function isDeviceDocument(value: unknown): value is DeviceDocument {
  return validateDeviceDocument(value).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFirestoreTimestamp(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.seconds) && Number(value.seconds) >= 0 &&
    Number.isInteger(value.nanoseconds) && Number(value.nanoseconds) >= 0 && Number(value.nanoseconds) < 1_000_000_000;
}
