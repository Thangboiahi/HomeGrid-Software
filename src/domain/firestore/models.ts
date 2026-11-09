/** Portable Firestore timestamp shape used by application-domain documents. */
export type FirestoreTimestamp = {
  readonly seconds: number;
  readonly nanoseconds: number;
};

export type DocumentTimestamps = {
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

export type AccountState = "pending" | "active" | "disabled";
export type AccessRole = "customer" | "installer" | "superAdmin";

export interface UserDocument extends DocumentTimestamps {
  uid: string;
  email?: string;
  displayName?: string;
  accountState: AccountState;
}

/** Access is server-managed; registration never writes this collection. */
export interface UserAccessDocument extends DocumentTimestamps {
  uid: string;
  role: AccessRole;
  state: "pending" | "active" | "suspended";
  grantedByUid?: string;
}

export type AccountAccessOperationKind = "suspend" | "reactivate";
export type AccountAccessOperationStatus = "pending" | "processing" | "completed" | "manualReview";
export type AccountAccessOperationStep = "authDisabled" | "authEnabled" | "refreshTokensRevoked";
export type AccountAccessFailurePhase = "auth-update" | "token-revocation" | "checkpoint-persistence" | "firestore-finalization" | "processor-interrupted";

/** Server-only retry/outbox state. Browser Firestore access remains denied. */
export interface AccountAccessOperationDocument extends DocumentTimestamps {
  uid: string;
  operationId: string;
  kind: AccountAccessOperationKind;
  status: AccountAccessOperationStatus;
  requestedByUid: string;
  requestedByRole: AccessRole;
  correlationId: string;
  attemptCount: number;
  manualRetryCount: number;
  nextAttemptAt?: FirestoreTimestamp;
  leaseExpiresAt?: FirestoreTimestamp;
  /** Internal processor lease owner; never returned by APIs. */
  leaseToken?: string;
  lastCompletedStep?: AccountAccessOperationStep;
  lastFailureCode?: string;
  lastFailurePhase?: AccountAccessFailurePhase;
  lastFailureAt?: FirestoreTimestamp;
  completedAt?: FirestoreTimestamp;
}

export type SessionSignOutStatus = "pending" | "processing" | "completed" | "manualReview";
export type SessionSignOutFailurePhase = "auth-revocation" | "firestore-finalization";

/** Server-only durable sign-out intent. Contains no session token or credential. */
export interface SessionSignOutOperationDocument extends DocumentTimestamps {
  operationId: string;
  uid: string;
  authTime: number;
  actorRole: AccessRole | "unknown";
  status: SessionSignOutStatus;
  attemptCount: number;
  /** Number of explicit operator requeue rounds after terminal manual review. */
  manualReviewCount: number;
  correlationId: string;
  nextAttemptAt?: FirestoreTimestamp;
  leaseExpiresAt?: FirestoreTimestamp;
  leaseToken?: string;
  lastFailurePhase?: SessionSignOutFailurePhase;
  lastFailureCode?: string;
  lastFailureAt?: FirestoreTimestamp;
  completedAt?: FirestoreTimestamp;
}

export interface CustomerDocument extends DocumentTimestamps {
  primaryUid: string;
  state: "active" | "inactive";
}

export interface HouseholdDocument extends DocumentTimestamps {
  displayName: string;
  memberUids: string[];
  createdByUid: string;
}

export interface InstallerDocument extends DocumentTimestamps {
  uid: string;
  organizationId?: string;
  state: "pending" | "active" | "inactive";
}

export interface ProductDefinitionDocument extends DocumentTimestamps {
  productCode: string;
  displayName: string;
  state: "draft" | "active" | "retired";
}

export interface DeviceDocument extends DocumentTimestamps {
  productDefinitionId: string;
  kind: "simulated" | "physical";
  /** Registry lifecycle only; not an indication of physical connectivity. */
  state: "unassigned" | "assigned" | "retired";
  householdId?: string;
  installationId?: string;
}

export interface InstallationDocument extends DocumentTimestamps {
  installerUid: string;
  customerId: string;
  householdId?: string;
  state: "scheduled" | "inProgress" | "completed" | "cancelled";
  scheduledAt?: FirestoreTimestamp;
  completedAt?: FirestoreTimestamp;
  completionNote?: string;
}

export interface FirmwareReleaseDocument extends DocumentTimestamps {
  productDefinitionId: string;
  versionLabel: string;
  state: "draft" | "approved" | "retired";
}

export interface DiagnosticRecordDocument extends DocumentTimestamps {
  source: "application" | "support";
  subjectType: "user" | "household" | "device" | "installation";
  subjectId: string;
  summary: string;
}

export interface AuditEventDocument {
  actorUid: string;
  actorRole: AccessRole | "system" | "unknown";
  executor?: "system";
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: "success" | "denied" | "failure";
  correlationId: string;
  occurredAt: FirestoreTimestamp;
}

export interface FirestoreDocumentMap {
  users: UserDocument;
  userAccess: UserAccessDocument;
  accountAccessOperations: AccountAccessOperationDocument;
  sessionSignOutOperations: SessionSignOutOperationDocument;
  customers: CustomerDocument;
  households: HouseholdDocument;
  installers: InstallerDocument;
  productDefinitions: ProductDefinitionDocument;
  devices: DeviceDocument;
  installations: InstallationDocument;
  firmwareReleases: FirmwareReleaseDocument;
  diagnosticRecords: DiagnosticRecordDocument;
  auditEvents: AuditEventDocument;
}

export type FirestoreCollection = keyof FirestoreDocumentMap;
