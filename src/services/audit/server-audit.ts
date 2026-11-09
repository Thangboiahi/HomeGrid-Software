import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { AccessRole } from "@/domain/firestore/models";
import { getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";

export async function resolveAuditActorRole(uid: string): Promise<AccessRole | "unknown"> {
  try {
    const role: unknown = (await getFirebaseAdminFirestore().collection("userAccess").doc(uid).get()).data()?.role;
    if (role === "customer" || role === "installer" || role === "superAdmin") return role;
  } catch {
    // The event remains useful with an explicit unknown role if lookup is unavailable.
  }
  return "unknown";
}

export type AuditEventInput = {
  actorUid?: string;
  actorRole?: AccessRole | "system" | "unknown";
  /** Identifies trusted outbox processing when the initiating actor is retained. */
  executor?: "system";
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: "success" | "denied" | "failure";
  correlationId?: string;
};

export type PreparedAuditEvent = DocumentData & {
  actorRole: AccessRole | "system" | "unknown";
  correlationId: string;
  occurredAt: FieldValue;
};

type TransactionAuditWriter = (
  transaction: Transaction,
  reference: DocumentReference,
  record: PreparedAuditEvent,
) => void;

function buildAuditEvent(event: AuditEventInput): PreparedAuditEvent {
  return {
    ...event,
    actorRole: event.actorRole ?? "unknown",
    correlationId: event.correlationId ?? randomUUID(),
    occurredAt: FieldValue.serverTimestamp(),
  };
}

function createAuditEventInTransaction(
  transaction: Transaction,
  reference: DocumentReference,
  record: PreparedAuditEvent,
): void {
  transaction.create(reference, record);
}

/** Prepare once before a transaction retry loop when the caller needs a stable event identity. */
export function prepareAuditEvent(event: AuditEventInput): PreparedAuditEvent {
  return buildAuditEvent(event);
}

/** Stage an already-prepared audit event in the caller's Firestore transaction. */
export function stagePreparedAuditEvent(
  transaction: Transaction,
  reference: DocumentReference,
  record: PreparedAuditEvent,
): void {
  createAuditEventInTransaction(transaction, reference, record);
}

/**
 * Creates a transaction runner that commits a mutation and its success audit
 * event together. The writer parameter is a failure-injection seam for tests;
 * application services use the default runner below.
 */
export function createAuditedTransactionRunner(
  writeAuditEvent: TransactionAuditWriter = createAuditEventInTransaction,
) {
  return async function runAuditedTransaction<T>(
    db: Firestore,
    event: AuditEventInput,
    mutation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    // Prepare stable identity and server timestamp once, outside the retryable
    // callback, so Firestore retries represent one logical operation/event.
    const auditRef = db.collection("auditEvents").doc();
    const auditRecord = prepareAuditEvent(event);

    return db.runTransaction(async (transaction) => {
      const result = await mutation(transaction);
      writeAuditEvent(transaction, auditRef, auditRecord);
      return result;
    });
  };
}

export const runAuditedTransaction = createAuditedTransactionRunner();

/** Persists one audit event; credentials and session values are never accepted. */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  const record = prepareAuditEvent(event);
  try {
    await getFirebaseAdminFirestore().collection("auditEvents").doc().create(record);
  } catch {
    // Structured fallback is deliberately credential-free. Callers still
    // receive a rejection so sensitive mutations can fail closed.
    console.error(JSON.stringify({
      event: "homegrid.security_audit.persist_failed",
      actorUid: event.actorUid,
      actorRole: record.actorRole,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      correlationId: record.correlationId,
      occurredAt: new Date().toISOString(),
    }));
    throw new Error("Security audit persistence failed.");
  }
}
