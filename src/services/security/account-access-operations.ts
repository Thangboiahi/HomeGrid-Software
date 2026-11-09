import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import type { AccessRole, AccountAccessOperationKind, AccountAccessOperationStatus } from "@/domain/firestore/models";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { AccountOperationConflictError, AuthorizationError, requirePermission, type AuthenticatedPrincipal } from "@/services/auth/authorization";
import { prepareAuditEvent, stagePreparedAuditEvent, type PreparedAuditEvent } from "@/services/audit/server-audit";
import { createOutboxSummary, outboxRunBudgetFromEnvironment, resolveOutboxRunBudget, runBoundedWorkers, selectDueOutboxCandidates, startOutboxLeaseHeartbeat, type OutboxRunBudgetOptions } from "@/services/security/outbox-processing";

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

type AuditStager = (transaction: Transaction, reference: DocumentReference, record: PreparedAuditEvent) => void;
type OperationResult = {
  uid: string;
  operationId: string;
  kind: AccountAccessOperationKind;
  status: AccountAccessOperationStatus;
  attemptCount: number;
  lastFailureCode?: string;
};
type OperationData = DocumentData & {
  uid: string;
  operationId: string;
  kind: AccountAccessOperationKind;
  status: AccountAccessOperationStatus;
  requestedByUid: string;
  requestedByRole: AccessRole;
  correlationId: string;
  attemptCount: number;
  manualRetryCount: number;
  lastFailureCode?: string;
  lastFailurePhase?: "auth-update" | "token-revocation" | "checkpoint-persistence" | "firestore-finalization" | "processor-interrupted";
};
type FailurePhase = NonNullable<OperationData["lastFailurePhase"]>;

export type AccountAccessCoordinator = ReturnType<typeof createAccountAccessCoordinator>;

/** Injectable Firebase boundary for emulator failure tests; production callers use the default coordinator. */
export function createAccountAccessCoordinator(dependencies: {
  db: Firestore;
  auth: Pick<Auth, "updateUser" | "revokeRefreshTokens" | "getUser">;
  now?: () => number;
  retryBaseMs?: number;
  maxAttempts?: number;
  stageAudit?: AuditStager;
  processingLeaseMs?: number;
  candidateSelector?: typeof selectDueOutboxCandidates;
}) {
  const now = dependencies.now ?? Date.now;
  const retryBaseMs = dependencies.retryBaseMs ?? RETRY_BASE_MS;
  const maxAttempts = dependencies.maxAttempts ?? MAX_ATTEMPTS;
  const stageAudit = dependencies.stageAudit ?? stagePreparedAuditEvent;
  const processingLeaseMs = dependencies.processingLeaseMs ?? PROCESSING_LEASE_MS;
  const db = dependencies.db;
  const auth = dependencies.auth;

  async function request(
    uid: string,
    kind: AccountAccessOperationKind,
    actor: Pick<AuthenticatedPrincipal, "uid" | "role">,
    retryManualReview = false,
    reconcileCompleted = false,
  ): Promise<OperationResult> {
    if (!uid || uid === actor.uid) throw new TypeError("A different target UID is required.");

    const operations = db.collection("accountAccessOperations");
    const operationRef = operations.doc(uid);
    const accessRef = db.collection("userAccess").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const proposedOperationId = randomUUID();
    const proposedCorrelationId = randomUUID();
    const requestEventRef = db.collection("auditEvents").doc(`${proposedOperationId}-requested`);
    const retryCorrelationId = randomUUID();

    const requested = await db.runTransaction(async (transaction) => {
      const [accessSnapshot, userSnapshot, operationSnapshot] = await Promise.all([
        transaction.get(accessRef),
        transaction.get(userRef),
        transaction.get(operationRef),
      ]);
      if (!accessSnapshot.exists || !userSnapshot.exists) throw new AuthorizationError("not-found", "Account not found.");
      const access = accessSnapshot.data()!;
      const user = userSnapshot.data()!;
      if (!isAccessRole(access.role)) throw new AuthorizationError("not-found", "Account not found.");

      const existing = operationSnapshot.exists ? operationSnapshot.data() as OperationData : undefined;
      if (existing?.status === "pending" || existing?.status === "processing") {
        if (existing.kind !== kind) throw new AccountOperationConflictError("Another account access operation is still pending.");
        return existing;
      }
      if (existing?.status === "manualReview" && existing.kind !== kind) {
        throw new AccountOperationConflictError("The existing account access operation requires manual review before another operation can start.");
      }
      if (existing?.kind === kind && existing.status === "manualReview" && !retryManualReview) return existing;
      const completedStateIsConsistent = kind === "suspend"
        ? access.state === "suspended" && user.accountState === "disabled"
        : access.state === "active" && user.accountState === "active";
      if (existing?.kind === kind && existing.status === "completed" && completedStateIsConsistent && !reconcileCompleted) return existing;

      if (existing?.status === "manualReview" && existing.kind === kind && retryManualReview) {
        const nextRetryCount = Number(existing.manualRetryCount ?? 0) + 1;
        const retryEventId = `${existing.operationId}-manual-retry-${nextRetryCount}`;
        const retryAuditRef = db.collection("auditEvents").doc(retryEventId);
        const retryEvent = prepareAuditEvent({
          actorUid: actor.uid,
          actorRole: actor.role,
          action: `accounts.${kind === "suspend" ? "suspension" : "reactivation"}.retry-requested`,
          resourceType: "userAccess",
          resourceId: uid,
          outcome: "success",
          correlationId: retryCorrelationId,
        });
        transaction.update(operationRef, {
          status: "pending",
          attemptCount: 0,
          manualRetryCount: nextRetryCount,
          lastFailureCode: FieldValue.delete(),
          lastFailurePhase: FieldValue.delete(),
          lastFailureAt: FieldValue.delete(),
          lastCompletedStep: FieldValue.delete(),
          nextAttemptAt: Timestamp.fromMillis(now()),
          leaseExpiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        stageAudit(transaction, retryAuditRef, retryEvent);
        return { ...existing, status: "pending", attemptCount: 0, manualRetryCount: nextRetryCount } as OperationData;
      }

      if (access.state !== "active" && access.state !== "suspended") throw new AuthorizationError("not-found", "Account not found.");
      if (user.accountState !== "active" && user.accountState !== "disabled") throw new AuthorizationError("not-found", "Account not found.");
      const completedReactivationDrift = reconcileCompleted && kind === "reactivate" && access.state === "active" && user.accountState === "active";
      if (kind === "reactivate" && !completedReactivationDrift && (access.state !== "suspended" || user.accountState !== "disabled")) {
        throw new TypeError("Only a fully suspended account can be reactivated.");
      }

      const operationId = proposedOperationId;
      const correlationId = proposedCorrelationId;
      const event = prepareAuditEvent({
        actorUid: actor.uid,
        actorRole: actor.role,
        action: kind === "suspend" ? "accounts.suspension.requested" : "accounts.reactivation.requested",
        resourceType: "userAccess",
        resourceId: uid,
        outcome: "success",
        correlationId,
      });
      const record = {
        uid,
        operationId,
        kind,
        status: "pending",
        requestedByUid: actor.uid,
        requestedByRole: actor.role,
        correlationId,
        attemptCount: 0,
        manualRetryCount: 0,
        nextAttemptAt: Timestamp.fromMillis(now()),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      // Re-entry after an unexpected external Auth state creates a new intent.
      // Reactivation always moves Firestore back to denied before Auth is touched.
      if (kind === "suspend" || kind === "reactivate") {
        transaction.update(accessRef, { state: "suspended", updatedAt: FieldValue.serverTimestamp() });
        transaction.update(userRef, { accountState: "disabled", updatedAt: FieldValue.serverTimestamp() });
      }
      if (operationSnapshot.exists) transaction.set(operationRef, record);
      else transaction.create(operationRef, record);
      stageAudit(transaction, requestEventRef, event);
      return record as OperationData;
    });

    // A completed request is idempotent, but reconcile if Auth has since drifted.
    if (requested.status === "completed" && !reconcileCompleted) {
      try {
        const authUser = await auth.getUser(uid);
        const consistent = kind === "suspend" ? authUser.disabled : !authUser.disabled;
        if (consistent) return toResult(requested);
        return request(uid, kind, actor, retryManualReview, true);
      } catch {
        return toResult(requested);
      }
    }
    if (requested.status === "manualReview") return toResult(requested);
    return process(uid);
  }

  async function process(uid: string, claimDeadlineAt?: number, claimReserveMs = 0): Promise<OperationResult> {
    const leaseToken = randomUUID();
    const operationRef = db.collection("accountAccessOperations").doc(uid);
    const claimTime = now();
    const claimed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operationRef);
      if (!snapshot.exists) throw new AuthorizationError("not-found", "Account operation not found.");
      const operation = snapshot.data() as OperationData;
      if (claimDeadlineAt !== undefined && now() + claimReserveMs >= claimDeadlineAt) return { operation, claimed: false };
      if (operation.status === "completed" || operation.status === "manualReview") return { operation, claimed: false };
      const leaseExpiresAt = timestampMillis(operation.leaseExpiresAt);
      if (operation.status === "processing" && leaseExpiresAt > claimTime) return { operation, claimed: false };
      const nextAttemptAt = timestampMillis(operation.nextAttemptAt);
      if (operation.status === "pending" && nextAttemptAt > claimTime) return { operation, claimed: false };
      if (Number(operation.attemptCount ?? 0) >= maxAttempts) {
        const failureAuditRef = db.collection("auditEvents").doc(
          `${operation.operationId}-failure-${operation.manualRetryCount}-${operation.attemptCount}`,
        );
        const failureAuditSnapshot = await transaction.get(failureAuditRef);
        const failureAudit = prepareAuditEvent({
          actorUid: operation.requestedByUid,
          actorRole: operation.requestedByRole,
          executor: "system",
          action: `${operation.kind === "suspend" ? "accounts.suspension" : "accounts.reactivation"}.processor-interrupted`,
          resourceType: "userAccess",
          resourceId: operation.uid,
          outcome: "failure",
          correlationId: operation.correlationId,
        });
        transaction.update(operationRef, {
          status: "manualReview",
          lastFailureCode: "processor/interrupted",
          lastFailurePhase: "processor-interrupted",
          lastFailureAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: FieldValue.delete(),
          leaseToken: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (!failureAuditSnapshot.exists) stageAudit(transaction, failureAuditRef, failureAudit);
        return { operation: { ...operation, status: "manualReview" } as OperationData, claimed: false };
      }
      transaction.update(operationRef, {
        status: "processing",
        attemptCount: Number(operation.attemptCount ?? 0) + 1,
        leaseExpiresAt: Timestamp.fromMillis(claimTime + processingLeaseMs),
        leaseToken,
        lastCompletedStep: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        operation: { ...operation, status: "processing", attemptCount: Number(operation.attemptCount ?? 0) + 1 } as OperationData,
        claimed: true,
      };
    });
    if (!claimed.claimed) return toResult(claimed.operation);

    const operation = claimed.operation;
    const heartbeat = startOutboxLeaseHeartbeat({ db, operationRef, operationId: operation.operationId, leaseToken, leaseMs: processingLeaseMs, initialLeaseExpiresAt: claimTime + processingLeaseMs, now });
    let phase: FailurePhase = "auth-update";
    try {
      await auth.updateUser(uid, { disabled: operation.kind === "suspend" });
      await heartbeat.assertCurrent();
      phase = "checkpoint-persistence";
      await checkpoint(operationRef, operation.operationId, leaseToken, operation.kind === "suspend" ? "authDisabled" : "authEnabled");
      phase = "token-revocation";
      await auth.revokeRefreshTokens(uid);
      await heartbeat.assertCurrent();
      phase = "checkpoint-persistence";
      await checkpoint(operationRef, operation.operationId, leaseToken, "refreshTokensRevoked");
      phase = "firestore-finalization";
      return await complete(operationRef, operation, leaseToken);
    } catch (error) {
      await persistFailure(operationRef, operation, leaseToken, phase, error).catch(() => {
        console.error(JSON.stringify({ event: "homegrid.account_access.failure_persistence_failed", operationId: operation.operationId }));
      });
      const current = await operationRef.get().catch(() => undefined);
      return current?.exists ? toResult(current.data() as OperationData) : toResult({ ...operation, status: "pending" });
    } finally {
      await heartbeat.stop();
    }
  }

  async function processPending(options: OutboxRunBudgetOptions = {}) {
    const started = now();
    const configured = outboxRunBudgetFromEnvironment("HOMEGRID_ACCOUNT_OUTBOX", globalThis.process.env, started);
    const resolvedBudget = resolveOutboxRunBudget({ ...configured, ...options, deadlineAt: options.deadlineAt ?? (options.maxRunMs === undefined ? configured.deadlineAt : started + options.maxRunMs) }, started);
    const summary = createOutboxSummary("accountAccess", started);
    try {
      const selection = await (dependencies.candidateSelector ?? selectDueOutboxCandidates)(db.collection("accountAccessOperations"), resolvedBudget, now);
      summary.candidatesSelected = selection.candidates.length;
      summary.pagesRead = selection.pagesRead;
      summary.deadlineReached = selection.deadlineReached;
      const candidates = selection.candidates.slice(0, resolvedBudget.maxClaimedOperations);
      const settled = await runBoundedWorkers(candidates, resolvedBudget.concurrency, async (candidate) => {
        if (now() + resolvedBudget.claimReserveMs >= resolvedBudget.deadlineAt) { summary.deadlineReached = true; return undefined; }
        summary.claimAttempts += 1;
        const before = candidate.data() as OperationData;
        const result = await process(candidate.id, resolvedBudget.deadlineAt, resolvedBudget.claimReserveMs);
        if (result.attemptCount > Number(before.attemptCount ?? 0)) summary.claimedOperations += 1;
        if (result.status === "completed") summary.completedOperations += 1;
        else if (result.status === "pending") summary.pendingOperations += 1;
        else if (result.status === "manualReview") summary.manualReviewOperations += 1;
        else summary.skippedOperations += 1;
        return result;
      });
      summary.operationErrors = settled.filter((result) => result.status === "rejected").length;
      if (summary.operationErrors) summary.status = "partial";
      if (summary.deadlineReached && summary.status === "completed") summary.status = "partial";
    } catch {
      summary.status = "failed";
      summary.failureCode = "outbox/candidate-query-failed";
      console.error(JSON.stringify({ event: "homegrid.account_access.outbox_failed", failureCode: summary.failureCode }));
    }
    const finished = createOutboxSummary("accountAccess", started, summary);
    console.info(JSON.stringify({ event: "homegrid.account_access.outbox_completed", ...finished }));
    return finished;
  }

  async function checkpoint(
    operationRef: DocumentReference,
    operationId: string,
    leaseToken: string,
    step: "authDisabled" | "authEnabled" | "refreshTokensRevoked",
  ): Promise<void> {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operationRef);
      const operation = snapshot.data() as OperationData | undefined;
      if (!operation || operation.operationId !== operationId || operation.status !== "processing" || operation.leaseToken !== leaseToken) {
        throw new Error("Account operation lease is no longer current.");
      }
      transaction.update(operationRef, { lastCompletedStep: step, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async function complete(operationRef: DocumentReference, operation: OperationData, leaseToken: string): Promise<OperationResult> {
    const accessRef = db.collection("userAccess").doc(operation.uid);
    const userRef = db.collection("users").doc(operation.uid);
    const auditRef = db.collection("auditEvents").doc(`${operation.operationId}-completed`);
    const event = prepareAuditEvent({
      actorUid: operation.requestedByUid,
      actorRole: operation.requestedByRole,
      executor: "system",
      action: operation.kind === "suspend" ? "accounts.suspended" : "accounts.reactivated",
      resourceType: "userAccess",
      resourceId: operation.uid,
      outcome: "success",
      correlationId: operation.correlationId,
    });
    return db.runTransaction(async (transaction) => {
      const [operationSnapshot, accessSnapshot, userSnapshot] = await Promise.all([
        transaction.get(operationRef),
        transaction.get(accessRef),
        transaction.get(userRef),
      ]);
      const current = operationSnapshot.data() as OperationData | undefined;
      if (!current || current.operationId !== operation.operationId) throw new AccountOperationConflictError("Account operation was superseded.");
      if (current.status === "completed") return toResult(current);
      if (current.status !== "processing" || current.leaseToken !== leaseToken) throw new AccountOperationConflictError("Account operation lease is no longer current.");
      if (!accessSnapshot.exists || !userSnapshot.exists) throw new AuthorizationError("not-found", "Account not found.");
      if (operation.kind === "suspend") {
        if (accessSnapshot.data()?.state !== "suspended" || userSnapshot.data()?.accountState !== "disabled") {
          throw new Error("Suspension access state is inconsistent.");
        }
      } else {
        if (accessSnapshot.data()?.state !== "suspended" || userSnapshot.data()?.accountState !== "disabled") {
          throw new Error("Reactivation access state is inconsistent.");
        }
        transaction.update(accessRef, { state: "active", updatedAt: FieldValue.serverTimestamp() });
        transaction.update(userRef, { accountState: "active", updatedAt: FieldValue.serverTimestamp() });
      }
      transaction.update(operationRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        lastFailureCode: FieldValue.delete(),
        lastFailurePhase: FieldValue.delete(),
        lastFailureAt: FieldValue.delete(),
        nextAttemptAt: FieldValue.delete(),
      });
      stageAudit(transaction, auditRef, event);
      return { ...current, status: "completed" } as OperationResult;
    });
  }

  async function persistFailure(operationRef: DocumentReference, operation: OperationData, leaseToken: string, phase: FailurePhase, error: unknown): Promise<void> {
    const failureCode = phase === "auth-update" || phase === "token-revocation"
      ? sanitizeAuthFailure(error)
      : phase === "firestore-finalization" || phase === "checkpoint-persistence" ? "firestore/operation-failed" : "processor/interrupted";
    const failureAuditRef = db.collection("auditEvents").doc(
      `${operation.operationId}-failure-${operation.manualRetryCount}-${operation.attemptCount}`,
    );
    const failureAudit = prepareAuditEvent({
      actorUid: operation.requestedByUid,
      actorRole: operation.requestedByRole,
      executor: "system",
      action: `${operation.kind === "suspend" ? "accounts.suspension" : "accounts.reactivation"}.${phase}-failed`,
      resourceType: "userAccess",
      resourceId: operation.uid,
      outcome: "failure",
      correlationId: operation.correlationId,
    });
    await db.runTransaction(async (transaction) => {
      const [operationSnapshot, failureEventSnapshot] = await Promise.all([
        transaction.get(operationRef),
        transaction.get(failureAuditRef),
      ]);
      const current = operationSnapshot.data() as OperationData | undefined;
      if (!current || current.operationId !== operation.operationId || current.status !== "processing" || current.leaseToken !== leaseToken) return;
      const permanent = (phase === "auth-update" || phase === "token-revocation") && isPermanentAuthFailure(error);
      const manualReview = permanent || current.attemptCount >= maxAttempts;
      const delay = Math.min(retryBaseMs * (2 ** Math.max(0, current.attemptCount - 1)), MAX_BACKOFF_MS);
      transaction.update(operationRef, {
        status: manualReview ? "manualReview" : "pending",
        lastFailureCode: failureCode,
        lastFailurePhase: phase,
        lastFailureAt: FieldValue.serverTimestamp(),
        nextAttemptAt: manualReview ? FieldValue.delete() : Timestamp.fromMillis(now() + delay),
        leaseExpiresAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!failureEventSnapshot.exists) stageAudit(transaction, failureAuditRef, failureAudit);
    });
  }

  return { request, process, processPending };
}

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
}

function isAccessRole(value: unknown): value is AccessRole {
  return value === "customer" || value === "installer" || value === "superAdmin";
}

function sanitizeAuthFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";
  const allowed = new Set([
    "auth/user-not-found",
    "auth/insufficient-permission",
    "auth/invalid-uid",
    "auth/network-request-failed",
    "auth/internal-error",
    "auth/too-many-requests",
    "auth/operation-not-allowed",
  ]);
  return allowed.has(code) ? code : "auth/unknown";
}

function isPermanentAuthFailure(error: unknown): boolean {
  const code = sanitizeAuthFailure(error);
  return code === "auth/user-not-found" || code === "auth/insufficient-permission" || code === "auth/invalid-uid" || code === "auth/operation-not-allowed";
}

function toResult(operation: OperationData): OperationResult {
  return {
    uid: operation.uid,
    operationId: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    attemptCount: operation.attemptCount,
    ...(operation.lastFailureCode ? { lastFailureCode: operation.lastFailureCode } : {}),
  };
}

function defaultCoordinator(): AccountAccessCoordinator {
  return createAccountAccessCoordinator({ db: getFirebaseAdminFirestore(), auth: getFirebaseAdminAuth() });
}

export async function requestAccountSuspension(uid: string, sessionCookie?: string, retryManualReview = false) {
  const actor = await requirePermission("users.manage", sessionCookie);
  return defaultCoordinator().request(uid, "suspend", actor, retryManualReview);
}

export async function requestAccountReactivation(uid: string, sessionCookie?: string, retryManualReview = false) {
  const actor = await requirePermission("users.manage", sessionCookie);
  return defaultCoordinator().request(uid, "reactivate", actor, retryManualReview);
}

/** Trusted local operator runner; callers must enforce their environment boundary before invoking. */
export async function processAccountAccessOperation(uid: string) {
  return defaultCoordinator().process(uid);
}

export async function processPendingAccountAccessOperations() {
  const db = getFirebaseAdminFirestore();
  const coordinator = createAccountAccessCoordinator({ db, auth: getFirebaseAdminAuth() });
  return coordinator.processPending();
}

