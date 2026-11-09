import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { DeviceDocument, ProductDefinitionDocument } from "@/domain/firestore/models";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import {
  AuthorizationError,
  requireAuthenticatedUser,
  requireHouseholdMembership,
  requireInstallationAssignment,
  requirePermission,
  type AuthenticatedPrincipal,
} from "@/services/auth/authorization";
import { runAuditedTransaction, type AuditEventInput } from "@/services/audit/server-audit";
import { requestAccountSuspension } from "@/services/security/account-access-operations";
import { validateDeviceAssociations, validateDeviceDocument } from "@/validation/device";

function auditContext(actor: AuthenticatedPrincipal, action: string, resourceType: string, resourceId: string, outcome: "success" | "denied" | "failure"): AuditEventInput {
  return { actorUid: actor.uid, actorRole: actor.role, action, resourceType, resourceId, outcome, correlationId: randomUUID() };
}

export async function readCustomerHousehold(householdId: string, sessionCookie?: string) {
  await requireHouseholdMembership(householdId, sessionCookie);
  const snapshot = await getFirebaseAdminFirestore().collection("households").doc(householdId).get();
  if (!snapshot.exists) throw new AuthorizationError("not-found", "Household not found.");
  const data = snapshot.data()!;
  return { id: snapshot.id, displayName: data.displayName, createdByUid: data.createdByUid };
}

export async function readOwnProfile(sessionCookie?: string) {
  const actor = await requirePermission("profile.read.own", sessionCookie);
  const db = getFirebaseAdminFirestore();
  const snapshot = await db.collection("users").doc(actor.uid).get();
  if (!snapshot.exists) throw new AuthorizationError("not-found", "Profile not found.");
  const data = snapshot.data()!;
  const roleCollection = actor.role === "installer" ? "installers" : actor.role === "customer" ? "customers" : undefined;
  const roleSnapshot = roleCollection ? await db.collection(roleCollection).doc(actor.uid).get() : undefined;
  return {
    uid: actor.uid,
    email: actor.email,
    displayName: data.displayName,
    role: actor.role,
    ...(actor.role === "installer" ? { organizationId: roleSnapshot?.data()?.organizationId, state: roleSnapshot?.data()?.state } : {}),
  };
}

export async function readCustomerInstallations(sessionCookie?: string) {
  const actor = await requirePermission("installations.read.available", sessionCookie);
  const db = getFirebaseAdminFirestore();
  const customer = await db.collection("customers").doc(actor.uid).get();
  if (!customer.exists || customer.data()?.primaryUid !== actor.uid || customer.data()?.state !== "active") return [];
  const results = await db.collection("installations").where("customerId", "==", customer.id).limit(100).get();
  return results.docs.map((doc) => ({ id: doc.id, state: doc.data().state, scheduledAt: doc.data().scheduledAt }));
}

export async function readCustomerDevices(householdId: string, sessionCookie?: string) {
  await requireHouseholdMembership(householdId, sessionCookie);
  const devices = await getFirebaseAdminFirestore().collection("devices").where("householdId", "==", householdId).get();
  return devices.docs.map((device) => ({ id: device.id, ...device.data() }));
}

export async function readCustomerHouseholds(sessionCookie?: string) {
  const actor = await requirePermission("households.read.member", sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("households").where("memberUids", "array-contains", actor.uid).limit(100).get();
  return result.docs.map((doc) => ({ id: doc.id, displayName: doc.data().displayName }));
}

export async function readDeviceById(deviceId: string, sessionCookie?: string) {
  const actor = await requireAuthenticatedUser(sessionCookie);
  const db = getFirebaseAdminFirestore();
  const snapshot = await db.collection("devices").doc(deviceId).get();
  if (!snapshot.exists) throw new AuthorizationError("not-found", "Device not found.");
  const device = snapshot.data()!;
  if (actor.role === "customer") {
    if (!device.householdId) throw new AuthorizationError("not-found", "Device not found.");
    await requireHouseholdMembership(device.householdId, sessionCookie);
  } else if (actor.role === "installer") {
    if (!device.installationId) throw new AuthorizationError("not-found", "Device not found.");
    await requireInstallationAssignment(device.installationId, sessionCookie);
  } else {
    await requirePermission("devices.read", sessionCookie);
  }
  const product = await db.collection("productDefinitions").doc(device.productDefinitionId).get();
  return {
    id: snapshot.id,
    ...device,
    product: product.exists ? { id: product.id, productCode: product.data()?.productCode, displayName: product.data()?.displayName, state: product.data()?.state } : undefined,
  };
}

export async function readAssignedInstallationDevices(installationId: string, sessionCookie?: string) {
  await requireInstallationAssignment(installationId, sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("devices").where("installationId", "==", installationId).limit(100).get();
  return result.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function readAssignedInstallation(installationId: string, sessionCookie?: string) {
  await requireInstallationAssignment(installationId, sessionCookie);
  const snapshot = await getFirebaseAdminFirestore().collection("installations").doc(installationId).get();
  if (!snapshot.exists) throw new AuthorizationError("not-found", "Installation not found.");
  return { id: snapshot.id, ...snapshot.data() };
}

export async function readAssignedInstallations(sessionCookie?: string) {
  const actor = await requirePermission("installations.read.assigned", sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("installations").where("installerUid", "==", actor.uid).limit(100).get();
  return result.docs.map((doc) => ({ id: doc.id, customerId: doc.data().customerId, householdId: doc.data().householdId, state: doc.data().state, scheduledAt: doc.data().scheduledAt }));
}

export async function readManagedInstallations(sessionCookie?: string) {
  await requirePermission("installations.read", sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("installations").limit(100).get();
  return result.docs.map((doc) => ({ id: doc.id, installerUid: doc.data().installerUid, customerId: doc.data().customerId, householdId: doc.data().householdId, state: doc.data().state, scheduledAt: doc.data().scheduledAt }));
}

export async function readManagedAccounts(sessionCookie?: string) {
  await requirePermission("users.read", sessionCookie);
  const db = getFirebaseAdminFirestore();
  const result = await db.collection("userAccess").limit(200).get();
  return Promise.all(result.docs.map(async (doc) => {
    const operation = await db.collection("accountAccessOperations").doc(doc.id).get();
    const operationData = operation.data();
    return {
      uid: doc.id,
      role: doc.data().role,
      state: doc.data().state,
      ...(operation.exists ? {
        accessOperation: {
          kind: operationData?.kind,
          status: operationData?.status,
          attemptCount: operationData?.attemptCount,
          lastFailureCode: operationData?.lastFailureCode,
        },
      } : {}),
    };
  }));
}

export async function updateAssignedInstallation(
  installationId: string,
  state: "inProgress" | "completed",
  sessionCookie?: string,
  completionNote?: string,
) {
  const actor = await requirePermission(state === "completed" ? "installations.complete" : "installations.progress.update", sessionCookie);
  const ref = getFirebaseAdminFirestore().collection("installations").doc(installationId);
  if (state === "completed" && (!completionNote?.trim() || completionNote.length > 1000)) throw new TypeError("Completion information is required and must be at most 1000 characters.");
  const db = getFirebaseAdminFirestore();
  return runAuditedTransaction(db, auditContext(actor, state === "completed" ? "installations.complete" : "installations.progress.update", "installation", installationId, "success"), async (transaction) => {
    const current = await transaction.get(ref);
    const currentState = current.data()?.state;
    if (!current.exists || current.data()?.installerUid !== actor.uid) throw new AuthorizationError("not-found", "Installation not found.");
    if ((state === "inProgress" && currentState !== "scheduled") || (state === "completed" && currentState !== "inProgress")) {
      throw new TypeError("Installation state transition is not allowed.");
    }
    transaction.update(ref, {
      state,
      ...(state === "completed" ? { completedAt: FieldValue.serverTimestamp(), completionNote: completionNote!.trim() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { id: installationId, state };
  });
}

export async function createProductDefinition(input: { productCode: string; displayName: string }, sessionCookie?: string) {
  const actor = await requirePermission("products.manage", sessionCookie);
  const productCode = input.productCode.trim();
  const displayName = input.displayName.trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(productCode) || displayName.length < 2 || displayName.length > 100) {
    throw new TypeError("Invalid product definition.");
  }
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("productDefinitions").doc(productCode);
  const now = FieldValue.serverTimestamp();
  const record: Omit<ProductDefinitionDocument, "createdAt" | "updatedAt"> & { createdAt: unknown; updatedAt: unknown } = { productCode, displayName, state: "draft", createdAt: now, updatedAt: now };
  return runAuditedTransaction(db, auditContext(actor, "products.created", "productDefinition", ref.id, "success"), async (transaction) => {
    transaction.create(ref, record);
    return { id: ref.id, productCode, displayName, state: "draft" as const };
  });
}

export async function readProductDefinitions(sessionCookie?: string) {
  await requirePermission("products.read", sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("productDefinitions").orderBy("productCode").limit(200).get();
  return result.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function readRegisteredDevices(sessionCookie?: string) {
  await requirePermission("devices.read", sessionCookie);
  const result = await getFirebaseAdminFirestore().collection("devices").orderBy("createdAt", "desc").limit(200).get();
  return result.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function createFirmwareRelease(input: { productDefinitionId: string; versionLabel: string }, sessionCookie?: string) {
  const actor = await requirePermission("firmwareReleases.manage", sessionCookie);
  const versionLabel = input.versionLabel.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(versionLabel)) throw new TypeError("Invalid version label.");
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("firmwareReleases").doc();
  const productRef = db.collection("productDefinitions").doc(input.productDefinitionId);
  const now = FieldValue.serverTimestamp();
  return runAuditedTransaction(db, auditContext(actor, "firmwareReleases.created", "firmwareRelease", ref.id, "success"), async (transaction) => {
    const product = await transaction.get(productRef);
    if (!product.exists || product.data()?.state !== "active") throw new TypeError("An active product definition is required.");
    transaction.create(ref, { productDefinitionId: input.productDefinitionId, versionLabel, state: "draft", createdAt: now, updatedAt: now });
    return { id: ref.id, productDefinitionId: input.productDefinitionId, versionLabel, state: "draft" as const };
  });
}

export async function setFirmwareReleaseState(releaseId: string, state: "approved" | "retired", sessionCookie?: string) {
  const actor = await requirePermission("firmwareReleases.manage", sessionCookie);
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("firmwareReleases").doc(releaseId);
  return runAuditedTransaction(db, auditContext(actor, "firmwareReleases.state.changed", "firmwareRelease", releaseId, "success"), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new AuthorizationError("not-found", "Firmware release not found.");
    const currentState = snapshot.data()?.state;
    if (!((currentState === "draft" && state === "approved") || (currentState === "approved" && state === "retired"))) {
      throw new TypeError("Firmware release state transition is not allowed.");
    }
    transaction.update(ref, { state, updatedAt: FieldValue.serverTimestamp() });
    return { id: releaseId, state };
  });
}

export async function registerDevice(input: {
  productDefinitionId: string;
  kind: "simulated" | "physical";
  householdId?: string;
  installationId?: string;
}, sessionCookie?: string) {
  const actor = await requirePermission("devices.register", sessionCookie);
  const hasAssociations = input.householdId !== undefined || input.installationId !== undefined;
  if (hasAssociations) await requirePermission("devices.assign", sessionCookie);
  const associationIssues = validateDeviceAssociations(input);
  if (associationIssues.length) throw new TypeError("Invalid device associations.");
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("devices").doc();
  const now = FieldValue.serverTimestamp();
  const record: Omit<DeviceDocument, "createdAt" | "updatedAt"> & { createdAt: typeof now; updatedAt: typeof now } = {
    productDefinitionId: input.productDefinitionId,
    kind: input.kind,
    state: hasAssociations ? "assigned" : "unassigned",
    ...(input.householdId ? { householdId: input.householdId } : {}),
    ...(input.installationId ? { installationId: input.installationId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const issues = validateDeviceDocument({ ...record, createdAt: { seconds: 0, nanoseconds: 0 }, updatedAt: { seconds: 0, nanoseconds: 0 } });
  if (issues.length) throw new TypeError("Invalid device registration document.");
  return runAuditedTransaction(db, auditContext(actor, "devices.registered", "device", ref.id, "success"), async (transaction) => {
    const [product, household, installation] = await Promise.all([
      transaction.get(db.collection("productDefinitions").doc(input.productDefinitionId)),
      input.householdId ? transaction.get(db.collection("households").doc(input.householdId)) : Promise.resolve(undefined),
      input.installationId ? transaction.get(db.collection("installations").doc(input.installationId)) : Promise.resolve(undefined),
    ]);
    if (!product.exists || product.data()?.state !== "active") throw new TypeError("An active product definition is required.");
    if (input.householdId && !household?.exists) throw new AuthorizationError("not-found", "Household not found.");
    if (input.installationId && !installation?.exists) throw new AuthorizationError("not-found", "Installation not found.");
    if (input.householdId && input.installationId) {
      const installationHouseholdId = installation?.data()?.householdId;
      if (typeof installationHouseholdId !== "string" || installationHouseholdId !== input.householdId) {
        throw new TypeError("Installation and household associations must reference the same household.");
      }
    }
    transaction.create(ref, record);
    return {
      id: ref.id,
      productDefinitionId: record.productDefinitionId,
      kind: record.kind,
      state: record.state,
      ...(record.householdId ? { householdId: record.householdId } : {}),
      ...(record.installationId ? { installationId: record.installationId } : {}),
    };
  });
}

export async function reassignDeviceProduct(deviceId: string, productDefinitionId: string, sessionCookie?: string) {
  const actor = await requirePermission("devices.assign", sessionCookie);
  await requirePermission("products.manage", sessionCookie);
  if (typeof productDefinitionId !== "string" || productDefinitionId.trim().length === 0) throw new TypeError("A valid product definition reference is required.");
  const db = getFirebaseAdminFirestore();
  const deviceRef = db.collection("devices").doc(deviceId);
  return runAuditedTransaction(db, auditContext(actor, "devices.product.assigned", "device", deviceId, "success"), async (transaction) => {
    const device = await transaction.get(deviceRef);
    const product = await transaction.get(db.collection("productDefinitions").doc(productDefinitionId));
    if (!device.exists || device.data()?.state === "retired") throw new AuthorizationError("not-found", "Device not found.");
    if (!product.exists || product.data()?.state !== "active") throw new TypeError("An active product definition is required.");
    if (device.data()?.productDefinitionId === productDefinitionId) throw new TypeError("Device already references this product definition.");
    transaction.update(deviceRef, { productDefinitionId, updatedAt: FieldValue.serverTimestamp() });
    return { id: deviceId, productDefinitionId };
  });
}

export async function readDeviceRegistryOverview(sessionCookie?: string) {
  await requirePermission("devices.read", sessionCookie);
  return readRegisteredDevices(sessionCookie);
}

export async function assignDevice(deviceId: string, target: { householdId?: string; installationId?: string }, sessionCookie?: string) {
  const actor = await requirePermission("devices.assign", sessionCookie);
  const associationIssues = validateDeviceAssociations(target);
  if (associationIssues.length || (!target.householdId && !target.installationId)) throw new TypeError("Invalid device associations.");
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("devices").doc(deviceId);
  const auditAction = target.householdId && target.installationId
    ? "devices.associations.updated"
    : target.householdId ? "devices.household.associated" : "devices.installation.associated";
  return runAuditedTransaction(db, auditContext(actor, auditAction, "device", deviceId, "success"), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.state === "retired") throw new AuthorizationError("not-found", "Device not found.");
    const current = snapshot.data()!;
    const resultingHouseholdId = target.householdId ?? current.householdId;
    const resultingInstallationId = target.installationId ?? current.installationId;
    const [household, installation] = await Promise.all([
      target.householdId ? transaction.get(db.collection("households").doc(target.householdId)) : Promise.resolve(undefined),
      resultingInstallationId ? transaction.get(db.collection("installations").doc(resultingInstallationId)) : Promise.resolve(undefined),
    ]);
    if (target.householdId && !household?.exists) throw new AuthorizationError("not-found", "Household not found.");
    if (resultingInstallationId && !installation?.exists) throw new AuthorizationError("not-found", "Installation not found.");
    const installationHouseholdId = installation?.data()?.householdId;
    if (resultingHouseholdId && resultingInstallationId &&
        (typeof installationHouseholdId !== "string" || installationHouseholdId !== resultingHouseholdId)) {
      throw new TypeError("Installation and household associations must reference the same household.");
    }
    const associationIssues = validateDeviceAssociations({
      ...(resultingHouseholdId ? { householdId: resultingHouseholdId } : {}),
      ...(resultingInstallationId ? { installationId: resultingInstallationId } : {}),
      ...(typeof installationHouseholdId === "string" ? { installationHouseholdId } : {}),
    });
    if (associationIssues.length) throw new TypeError("Installation and household associations conflict.");
    const currentHouseholdId = current.householdId;
    if (currentHouseholdId && target.householdId && currentHouseholdId !== target.householdId) {
      throw new TypeError("Cross-household device reassignment is not defined and is rejected.");
    }
    if (current.state === "assigned" && resultingHouseholdId === current.householdId && resultingInstallationId === current.installationId) {
      throw new TypeError("Device already has the requested associations.");
    }
    transaction.update(ref, {
      state: "assigned",
      ...(target.householdId ? { householdId: target.householdId } : {}),
      ...(target.installationId ? { installationId: target.installationId } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { id: deviceId, state: "assigned" as const, ...target };
  });
}

export async function assignInstaller(installationId: string, installerUid: string, sessionCookie?: string) {
  const actor = await requirePermission("installations.manage", sessionCookie);
  if (!installerUid || installerUid === actor.uid) throw new TypeError("A valid installer UID is required.");
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("installations").doc(installationId);
  return runAuditedTransaction(db, auditContext(actor, "installations.assigned", "installation", installationId, "success"), async (transaction) => {
    const [access, installer, snapshot] = await Promise.all([
      transaction.get(db.collection("userAccess").doc(installerUid)),
      transaction.get(db.collection("installers").doc(installerUid)),
      transaction.get(ref),
    ]);
    if (!access.exists || access.data()?.role !== "installer" || access.data()?.state !== "active" || !installer.exists || installer.data()?.state !== "active") {
      throw new TypeError("Target account is not an active installer.");
    }
    if (!snapshot.exists) throw new AuthorizationError("not-found", "Installation not found.");
    transaction.update(ref, { installerUid, updatedAt: FieldValue.serverTimestamp() });
    return { id: installationId, installerUid };
  });
}

export async function readDiagnostics(sessionCookie?: string) {
  await requirePermission("diagnostics.read", sessionCookie);
  const results = await getFirebaseAdminFirestore().collection("diagnosticRecords").orderBy("createdAt", "desc").limit(100).get();
  return results.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function readAssignedInstallationDiagnostics(installationId: string, sessionCookie?: string) {
  await requireInstallationAssignment(installationId, sessionCookie);
  const db = getFirebaseAdminFirestore();
  const devices = await db.collection("devices").where("installationId", "==", installationId).limit(100).get();
  const scopedIds = [installationId, ...devices.docs.map((device) => device.id)];
  const snapshots = await Promise.all(scopedIds.map((id) => db.collection("diagnosticRecords").where("subjectId", "==", id).limit(100).get()));
  return snapshots.flatMap((result) => result.docs
    .filter((doc) => doc.data().subjectType === "installation" || doc.data().subjectType === "device")
    .map((doc) => ({ id: doc.id, ...doc.data() })));
}

export async function readAuditEvents(sessionCookie?: string) {
  await requirePermission("auditEvents.read", sessionCookie);
  const results = await getFirebaseAdminFirestore().collection("auditEvents").orderBy("occurredAt", "desc").limit(100).get();
  return results.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function setProductDefinitionState(
  productId: string,
  state: "active" | "retired",
  sessionCookie?: string,
) {
  const actor = await requirePermission("products.manage", sessionCookie);
  const db = getFirebaseAdminFirestore();
  const ref = db.collection("productDefinitions").doc(productId);
  return runAuditedTransaction(db, auditContext(actor, "products.state.changed", "productDefinition", productId, "success"), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new AuthorizationError("not-found", "Product definition not found.");
    const oldState = snapshot.data()?.state;
    const allowed = (oldState === "draft" && state === "active") || (oldState === "active" && state === "retired");
    if (!allowed) throw new TypeError("Product state transition is not allowed.");
    transaction.update(ref, { state, updatedAt: FieldValue.serverTimestamp() });
    return { id: productId, state };
  });
}

export async function provisionAccount(
  targetUid: string,
  role: "customer" | "installer",
  sessionCookie?: string,
) {
  const actor = await requirePermission("users.manage", sessionCookie);
  if (!targetUid || targetUid === actor.uid) throw new TypeError("A different target UID is required.");
  const auth = getFirebaseAdminAuth();
  const authUser = await auth.getUser(targetUid);
  if (authUser.disabled) throw new TypeError("Disabled Auth accounts cannot be provisioned.");
  const db = getFirebaseAdminFirestore();
  const accessRef = db.collection("userAccess").doc(targetUid);
  const userRef = db.collection("users").doc(targetUid);
  const now = FieldValue.serverTimestamp();
  const roleRef = role === "customer"
    ? db.collection("customers").doc(targetUid)
    : db.collection("installers").doc(targetUid);
  return runAuditedTransaction(db, auditContext(actor, "accounts.provisioned", "userAccess", targetUid, "success"), async (transaction) => {
    const existingAccess = await transaction.get(accessRef);
    if (existingAccess.exists) throw new TypeError("An access record already exists; role changes require a separate reviewed operation.");
    transaction.create(userRef, {
      uid: targetUid,
      ...(authUser.email ? { email: authUser.email } : {}),
      ...(authUser.displayName ? { displayName: authUser.displayName } : {}),
      accountState: "active",
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(accessRef, { uid: targetUid, role, state: "active", grantedByUid: actor.uid, createdAt: now, updatedAt: now });
    if (role === "customer") {
      transaction.create(roleRef, { primaryUid: targetUid, state: "active", createdAt: now, updatedAt: now });
    } else {
      transaction.create(roleRef, { uid: targetUid, state: "active", createdAt: now, updatedAt: now });
    }
    return { uid: targetUid, role, state: "active" as const };
  });
}

export async function suspendAccount(targetUid: string, sessionCookie?: string, retryManualReview = false) {
  return requestAccountSuspension(targetUid, sessionCookie, retryManualReview);
}

