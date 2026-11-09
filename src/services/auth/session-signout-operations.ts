import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import type { AccessRole, SessionSignOutFailurePhase, SessionSignOutStatus } from "@/domain/firestore/models";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { requirePermission, type AuthenticatedPrincipal } from "@/services/auth/authorization";
import { prepareAuditEvent, stagePreparedAuditEvent, type PreparedAuditEvent } from "@/services/audit/server-audit";
import { createOutboxSummary, outboxRunBudgetFromEnvironment, resolveOutboxRunBudget, runBoundedWorkers, selectDueOutboxCandidates, startOutboxLeaseHeartbeat, type OutboxRunBudgetOptions } from "@/services/security/outbox-processing";

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 60 * 1000;

type AuditStager = (transaction: Transaction, reference: DocumentReference, record: PreparedAuditEvent) => void;
type SignOutOperation = DocumentData & {
  operationId: string;
  uid: string;
  authTime: number;
  actorRole: AccessRole | "unknown";
  status: SessionSignOutStatus;
  attemptCount: number;
  manualReviewCount: number;
  correlationId: string;
  lastFailurePhase?: SessionSignOutFailurePhase;
  lastFailureCode?: string;
};

export type SessionSignOutResult = {
  operationId: string;
  status: SessionSignOutStatus;
  attemptCount: number;
  lastFailureCode?: string;
};

/** Stable opaque lookup key. The bearer cookie itself is never persisted. */
export function sessionSignOutOperationId(sessionCookie: string): string {
  return createHash("sha256").update(sessionCookie, "utf8").digest("hex");
}

export type SessionSignOutCoordinator = ReturnType<typeof createSessionSignOutCoordinator>;

export function createSessionSignOutCoordinator(dependencies: {
  db: Firestore;
  auth: Pick<Auth, "revokeRefreshTokens">;
  now?: () => number;
  retryBaseMs?: number;
  maxAttempts?: number;
  stageAudit?: AuditStager;
  processingLeaseMs?: number;
  candidateSelector?: typeof selectDueOutboxCandidates;
}) {
  const db = dependencies.db;
  const auth = dependencies.auth;
  const now = dependencies.now ?? Date.now;
  const retryBaseMs = dependencies.retryBaseMs ?? RETRY_BASE_MS;
  const maxAttempts = dependencies.maxAttempts ?? MAX_ATTEMPTS;
  const stageAudit = dependencies.stageAudit ?? stagePreparedAuditEvent;
  const processingLeaseMs = dependencies.processingLeaseMs ?? PROCESSING_LEASE_MS;

  async function begin(input: {
    operationId: string;
    uid: string;
    authTime: number;
    actorRole: AccessRole | "unknown";
  }): Promise<SessionSignOutResult> {
    const operationRef = db.collection("sessionSignOutOperations").doc(input.operationId);
    const requestAuditRef = db.collection("auditEvents").doc(`${input.operationId}-requested`);
    const correlationId = randomUUID();
    const event = prepareAuditEvent({
      actorUid: input.uid,
      actorRole: input.actorRole,
      action: "auth.session.sign_out.requested",
      resourceType: "authSession",
      resourceId: input.operationId,
      outcome: "success",
      correlationId,
    });

    const operation = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(operationRef);
      if (existing.exists) return existing.data() as SignOutOperation;
      const record = {
        operationId: input.operationId,
        uid: input.uid,
        authTime: input.authTime,
        actorRole: input.actorRole,
        status: "pending" as const,
        attemptCount: 0,
        manualReviewCount: 0,
        correlationId,
        nextAttemptAt: Timestamp.fromMillis(now()),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.create(operationRef, record);
      stageAudit(transaction, requestAuditRef, event);
      return record as SignOutOperation;
    });
    return toResult(operation);
  }

  async function process(operationId: string, claimDeadlineAt?: number, claimReserveMs = 0): Promise<SessionSignOutResult> {
    const operationRef = db.collection("sessionSignOutOperations").doc(operationId);
    const leaseToken = randomUUID();
    const claimTime = now();
    const claimed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operationRef);
      if (!snapshot.exists) throw new Error("Sign-out operation not found.");
      const operation = snapshot.data() as SignOutOperation;
      if (claimDeadlineAt !== undefined && now() + claimReserveMs >= claimDeadlineAt) return { operation, claimed: false };
      if (operation.status === "completed" || operation.status === "manualReview") return { operation, claimed: false };
      const leaseExpiresAt = timestampMillis(operation.leaseExpiresAt);
      if (operation.status === "processing" && leaseExpiresAt > claimTime) return { operation, claimed: false };
      if (timestampMillis(operation.nextAttemptAt) > claimTime) return { operation, claimed: false };
      const attemptCount = Number(operation.attemptCount ?? 0) + 1;
      transaction.update(operationRef, {
        status: "processing",
        attemptCount,
        leaseToken,
        leaseExpiresAt: Timestamp.fromMillis(claimTime + processingLeaseMs),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { operation: { ...operation, status: "processing", attemptCount } as SignOutOperation, claimed: true };
    });
    if (!claimed.claimed) return toResult(claimed.operation);

    const operation = claimed.operation;
    const heartbeat = startOutboxLeaseHeartbeat({ db, operationRef, operationId: operation.operationId, leaseToken, leaseMs: processingLeaseMs, initialLeaseExpiresAt: claimTime + processingLeaseMs, now });
    let phase: SessionSignOutFailurePhase = "auth-revocation";
    try {
      await heartbeat.assertCurrent();
      await waitUntilSessionIsRevocable(operation.authTime, now);
      await heartbeat.assertCurrent();
      // Firebase refresh-token revocation is safe to repeat after uncertain outcomes.
      await auth.revokeRefreshTokens(operation.uid);
      await heartbeat.assertCurrent();
      phase = "firestore-finalization";
      return await complete(operationRef, operation, leaseToken);
    } catch (error) {
      await persistFailure(operationRef, operation, leaseToken, phase, error).catch(() => {
        console.error(JSON.stringify({ event: "homegrid.session_signout.failure_persistence_failed", operationId }));
      });
      const current = await operationRef.get().catch(() => undefined);
      return current?.exists ? toResult(current.data() as SignOutOperation) : toResult({ ...operation, status: "pending" });
    } finally {
      await heartbeat.stop();
    }
  }

  /** An operator may only requeue the existing manual-review operation; Auth remains processor-owned. */
  async function retryManualReview(
    operationId: string,
    actor: Pick<AuthenticatedPrincipal, "uid" | "role">,
  ): Promise<{ status: "retryRequested"; operationId: string; manualReviewCount: number } | { status: "alreadyPending" | "processing" | "completed" | "notFound" }> {
    const operationRef = db.collection("sessionSignOutOperations").doc(operationId);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operationRef);
      const current = snapshot.data() as SignOutOperation | undefined;
      if (!current || current.operationId !== operationId) return { status: "notFound" };
      if (current.status === "pending") return { status: "alreadyPending" };
      if (current.status === "processing") return { status: "processing" };
      if (current.status === "completed") return { status: "completed" };
      if (current.status !== "manualReview") return { status: "notFound" };

      const manualReviewCount = Number.isSafeInteger(current.manualReviewCount) && current.manualReviewCount >= 0
        ? current.manualReviewCount + 1
        : 1;
      const auditRef = db.collection("auditEvents").doc(`${operationId}-manual-retry-${manualReviewCount}`);
      const event = prepareAuditEvent({
        actorUid: actor.uid,
        actorRole: actor.role,
        action: "auth.session.sign_out.retry-requested",
        resourceType: "authSession",
        resourceId: operationId,
        outcome: "success",
        correlationId: current.correlationId,
      });
      transaction.update(operationRef, {
        status: "pending",
        attemptCount: 0,
        manualReviewCount,
        nextAttemptAt: Timestamp.fromMillis(now()),
        leaseExpiresAt: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        lastFailurePhase: FieldValue.delete(),
        lastFailureCode: FieldValue.delete(),
        lastFailureAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      stageAudit(transaction, auditRef, event);
      return { status: "retryRequested", operationId, manualReviewCount };
    });
  }

  async function complete(operationRef: DocumentReference, operation: SignOutOperation, leaseToken: string): Promise<SessionSignOutResult> {
    const auditRef = db.collection("auditEvents").doc(`${operation.operationId}-completed`);
    const event = prepareAuditEvent({
      actorUid: operation.uid,
      actorRole: operation.actorRole,
      executor: "system",
      action: "auth.session.ended",
      resourceType: "authSession",
      resourceId: operation.operationId,
      outcome: "success",
      correlationId: operation.correlationId,
    });
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operationRef);
      const current = snapshot.data() as SignOutOperation | undefined;
      if (!current || current.operationId !== operation.operationId) throw new Error("Sign-out operation was superseded.");
      if (current.status === "completed") return toResult(current);
      if (current.status !== "processing" || current.leaseToken !== leaseToken) throw new Error("Sign-out operation lease is no longer current.");
      transaction.update(operationRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        leaseToken: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(),
        nextAttemptAt: FieldValue.delete(),
        lastFailurePhase: FieldValue.delete(),
        lastFailureCode: FieldValue.delete(),
        lastFailureAt: FieldValue.delete(),
      });
      stageAudit(transaction, auditRef, event);
      return { ...toResult(current), status: "completed" };
    });
  }

  async function persistFailure(
    operationRef: DocumentReference,
    operation: SignOutOperation,
    leaseToken: string,
    phase: SessionSignOutFailurePhase,
    error: unknown,
  ): Promise<void> {
    const failureCode = phase === "auth-revocation" ? sanitizeAuthFailure(error) : "firestore/operation-failed";
    const action = phase === "auth-revocation" ? "auth.session.sign_out.revocation-failed" : "auth.session.sign_out.finalization-failed";
    const failureRef = db.collection("auditEvents").doc(`${operation.operationId}-failure-${operation.attemptCount}`);
    const event = prepareAuditEvent({
      actorUid: operation.uid,
      actorRole: operation.actorRole,
      executor: "system",
      action,
      resourceType: "authSession",
      resourceId: operation.operationId,
      outcome: "failure",
      correlationId: operation.correlationId,
    });
    await db.runTransaction(async (transaction) => {
      const [snapshot, failureSnapshot] = await Promise.all([transaction.get(operationRef), transaction.get(failureRef)]);
      const current = snapshot.data() as SignOutOperation | undefined;
      if (!current || current.operationId !== operation.operationId || current.status !== "processing" || current.leaseToken !== leaseToken) return;
      const manualReview = (phase === "auth-revocation" && isPermanentAuthFailure(error)) || current.attemptCount >= maxAttempts;
      const delay = Math.min(retryBaseMs * (2 ** Math.max(0, current.attemptCount - 1)), MAX_BACKOFF_MS);
      transaction.update(operationRef, {
        status: manualReview ? "manualReview" : "pending",
        lastFailurePhase: phase,
        lastFailureCode: failureCode,
        lastFailureAt: FieldValue.serverTimestamp(),
        nextAttemptAt: manualReview ? FieldValue.delete() : Timestamp.fromMillis(now() + delay),
        leaseToken: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!failureSnapshot.exists) stageAudit(transaction, failureRef, event);
    });
  }

  async function processPending(options: OutboxRunBudgetOptions = {}) {
    const started = now();
    const configured = outboxRunBudgetFromEnvironment("HOMEGRID_SESSION_OUTBOX", globalThis.process.env, started);
    const resolvedBudget = resolveOutboxRunBudget({ ...configured, ...options, deadlineAt: options.deadlineAt ?? (options.maxRunMs === undefined ? configured.deadlineAt : started + options.maxRunMs) }, started);
    const summary = createOutboxSummary("sessionSignOut", started);
    try {
      const selection = await (dependencies.candidateSelector ?? selectDueOutboxCandidates)(db.collection("sessionSignOutOperations"), resolvedBudget, now);
      summary.candidatesSelected = selection.candidates.length;
      summary.pagesRead = selection.pagesRead;
      summary.deadlineReached = selection.deadlineReached;
      const candidates = selection.candidates.slice(0, resolvedBudget.maxClaimedOperations);
      const settled = await runBoundedWorkers(candidates, resolvedBudget.concurrency, async (candidate) => {
        if (now() + resolvedBudget.claimReserveMs >= resolvedBudget.deadlineAt) { summary.deadlineReached = true; return undefined; }
        summary.claimAttempts += 1;
        const before = candidate.data() as SignOutOperation;
        const result = await process(candidate.id, resolvedBudget.deadlineAt, resolvedBudget.claimReserveMs);
        if (result.attemptCount > Number(before.attemptCount ?? 0)) summary.claimedOperations += 1;
        if (result.status === "completed") summary.completedOperations += 1;
        else if (result.status === "pending") summary.pendingOperations += 1;
        else if (result.status === "manualReview") summary.manualReviewOperations += 1;
        else summary.skippedOperations += 1;
        return result;
      });
      summary.operationErrors = settled.filter((result) => result.status === "rejected").length;
      if (summary.operationErrors || summary.deadlineReached) summary.status = "partial";
    } catch {
      summary.status = "failed";
      summary.failureCode = "outbox/candidate-query-failed";
      console.error(JSON.stringify({ event: "homegrid.session_signout.outbox_failed", failureCode: summary.failureCode }));
    }
    const finished = createOutboxSummary("sessionSignOut", started, summary);
    console.info(JSON.stringify({ event: "homegrid.session_signout.outbox_completed", ...finished }));
    return finished;
  }

  async function get(operationId: string): Promise<SignOutOperation | undefined> {
    const snapshot = await db.collection("sessionSignOutOperations").doc(operationId).get();
    return snapshot.exists ? snapshot.data() as SignOutOperation : undefined;
  }

  return { begin, process, processPending, retryManualReview, get };
}

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
}

async function waitUntilSessionIsRevocable(authTime: number, now: () => number): Promise<void> {
  if (!Number.isFinite(authTime)) throw Object.assign(new Error("Invalid auth time."), { code: "auth/invalid-auth-time" });
  const delay = Math.max(0, (Math.floor(authTime) + 1) * 1000 - now());
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function sanitizeAuthFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "auth/unknown";
  const allowed = new Set([
    "auth/user-not-found",
    "auth/insufficient-permission",
    "auth/invalid-uid",
    "auth/network-request-failed",
    "auth/internal-error",
    "auth/too-many-requests",
    "auth/operation-not-allowed",
    "auth/invalid-auth-time",
  ]);
  return allowed.has(code) ? code : "auth/unknown";
}

function isPermanentAuthFailure(error: unknown): boolean {
  const code = sanitizeAuthFailure(error);
  return code === "auth/user-not-found" || code === "auth/insufficient-permission" || code === "auth/invalid-uid" || code === "auth/operation-not-allowed" || code === "auth/invalid-auth-time";
}

function toResult(operation: SignOutOperation): SessionSignOutResult {
  return {
    operationId: operation.operationId,
    status: operation.status,
    attemptCount: operation.attemptCount,
    ...(operation.lastFailureCode ? { lastFailureCode: operation.lastFailureCode } : {}),
  };
}

function defaultCoordinator() {
  return createSessionSignOutCoordinator({ db: getFirebaseAdminFirestore(), auth: getFirebaseAdminAuth() });
}

/** Trusted server/operator entry point; callers must retain their own access boundary. */
export async function processPendingSessionSignOutOperations() {
  return defaultCoordinator().processPending();
}

/** Trusted operator entry point. Permission and actor identity come only from the verified server session. */
export async function requestSessionSignOutManualRetry(operationId: string, sessionCookie?: string) {
  const actor = await requirePermission("users.manage", sessionCookie);
  return defaultCoordinator().retryManualReview(operationId, actor);
}
