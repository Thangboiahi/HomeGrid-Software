import "server-only";

import { FieldPath, Timestamp, type CollectionReference, type DocumentData, type Firestore, type Query, type QueryDocumentSnapshot, type DocumentReference } from "firebase-admin/firestore";

export type OutboxRunBudget = {
  maxCandidates: number;
  maxClaimedOperations: number;
  deadlineAt: number;
  maxPages: number;
  pageSize: number;
  concurrency: number;
  claimReserveMs: number;
};

export type OutboxRunBudgetOptions = Partial<Omit<OutboxRunBudget, "deadlineAt">> & {
  deadlineAt?: number;
  maxRunMs?: number;
};

export type OutboxCandidateSelection = {
  candidates: QueryDocumentSnapshot<DocumentData>[];
  pagesRead: number;
  deadlineReached: boolean;
};

export type OutboxProcessorSummary = {
  domain: "accountAccess" | "sessionSignOut";
  status: "completed" | "partial" | "failed";
  candidatesSelected: number;
  pagesRead: number;
  claimAttempts: number;
  claimedOperations: number;
  completedOperations: number;
  pendingOperations: number;
  manualReviewOperations: number;
  skippedOperations: number;
  operationErrors: number;
  deadlineReached: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  failureCode?: string;
};

export function resolveOutboxRunBudget(options: OutboxRunBudgetOptions = {}, now = Date.now()): OutboxRunBudget {
  const maxRunMs = options.maxRunMs ?? 45_000;
  const budget: OutboxRunBudget = {
    maxCandidates: options.maxCandidates ?? 100,
    maxClaimedOperations: options.maxClaimedOperations ?? 20,
    deadlineAt: options.deadlineAt ?? now + maxRunMs,
    maxPages: options.maxPages ?? 8,
    pageSize: options.pageSize ?? 25,
    concurrency: options.concurrency ?? 2,
    claimReserveMs: options.claimReserveMs ?? 2_000,
  };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0 || (name !== "deadlineAt" && !Number.isInteger(value))) {
      throw new TypeError(`Invalid outbox run budget: ${name}.`);
    }
  }
  if (budget.maxCandidates < 1 || budget.maxPages < 1 || budget.pageSize < 1 || budget.concurrency < 1 || budget.maxClaimedOperations < 0) {
    throw new TypeError("Outbox run limits must be positive, except maxClaimedOperations which may be zero.");
  }
  return budget;
}

export function outboxRunBudgetFromEnvironment(prefix: "HOMEGRID_ACCOUNT_OUTBOX" | "HOMEGRID_SESSION_OUTBOX", env = process.env, now = Date.now()): OutboxRunBudget {
  const read = (suffix: string, fallback: number) => {
    const value = env[`${prefix}_${suffix}`];
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(value)) throw new TypeError(`Invalid ${prefix}_${suffix} configuration.`);
    return Number(value);
  };
  return resolveOutboxRunBudget({
    maxCandidates: read("MAX_CANDIDATES", 100),
    maxClaimedOperations: read("MAX_CLAIMS", 20),
    maxRunMs: read("MAX_RUN_MS", 45_000),
    maxPages: read("MAX_PAGES", 8),
    pageSize: read("PAGE_SIZE", 25),
    concurrency: read("CONCURRENCY", 2),
    claimReserveMs: read("CLAIM_RESERVE_MS", 2_000),
  }, now);
}

/** Fair bounded pagination over due pending work and expired processing leases. */
export async function selectDueOutboxCandidates(
  collection: CollectionReference<DocumentData>,
  budget: OutboxRunBudget,
  now: () => number = Date.now,
): Promise<OutboxCandidateSelection> {
  const cutoff = Timestamp.fromMillis(now());
  const streams: Array<{ query: Query<DocumentData>; cursor?: QueryDocumentSnapshot<DocumentData>; done: boolean }> = [
    {
      query: collection.where("status", "==", "pending").where("nextAttemptAt", "<=", cutoff)
        .orderBy("nextAttemptAt", "asc").orderBy(FieldPath.documentId(), "asc"),
      done: false,
    },
    {
      query: collection.where("status", "==", "processing").where("leaseExpiresAt", "<=", cutoff)
        .orderBy("leaseExpiresAt", "asc").orderBy(FieldPath.documentId(), "asc"),
      done: false,
    },
  ];
  const candidates: QueryDocumentSnapshot<DocumentData>[] = [];
  let pagesRead = 0;
  let nextStream = 0;
  let deadlineReached = false;

  while (candidates.length < budget.maxCandidates && pagesRead < budget.maxPages && streams.some((stream) => !stream.done)) {
    if (now() >= budget.deadlineAt) {
      deadlineReached = true;
      break;
    }
    let foundStream = false;
    for (let offset = 0; offset < streams.length; offset += 1) {
      const index = (nextStream + offset) % streams.length;
      const stream = streams[index];
      if (stream.done || candidates.length >= budget.maxCandidates || pagesRead >= budget.maxPages) continue;
      foundStream = true;
      const remaining = budget.maxCandidates - candidates.length;
      const activeStreams = streams.filter((candidateStream) => !candidateStream.done).length;
      const limit = Math.min(budget.pageSize, Math.max(1, Math.ceil(remaining / activeStreams)));
      const query = stream.cursor ? stream.query.startAfter(stream.cursor).limit(limit) : stream.query.limit(limit);
      const page = await query.get();
      pagesRead += 1;
      if (page.empty) {
        stream.done = true;
      } else {
        candidates.push(...page.docs.slice(0, budget.maxCandidates - candidates.length));
        stream.cursor = page.docs.at(-1);
        if (page.size < limit) stream.done = true;
      }
      nextStream = (index + 1) % streams.length;
      if (now() >= budget.deadlineAt) {
        deadlineReached = true;
        break;
      }
    }
    if (!foundStream) break;
  }

  return { candidates, pagesRead, deadlineReached };
}

export class OutboxLeaseLostError extends Error {
  readonly code = "outbox/lease-lost";
  constructor() {
    super("Outbox processing lease is no longer current.");
    this.name = "OutboxLeaseLostError";
  }
}

/** Renews a processing lease during potentially long Firebase Auth calls. */
export function startOutboxLeaseHeartbeat(input: {
  db: Firestore;
  operationRef: DocumentReference;
  operationId: string;
  leaseToken: string;
  leaseMs: number;
  initialLeaseExpiresAt: number;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const intervalMs = Math.max(100, Math.floor(input.leaseMs / 3));
  let stopped = false;
  let lost = false;
  let leaseUntil = input.initialLeaseExpiresAt;

  async function renew(): Promise<boolean> {
    const renewedUntil = now() + input.leaseMs;
    return input.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(input.operationRef);
      const operation = snapshot.data();
      if (!operation || operation.operationId !== input.operationId || operation.status !== "processing" || operation.leaseToken !== input.leaseToken) return false;
      transaction.update(input.operationRef, { leaseExpiresAt: Timestamp.fromMillis(renewedUntil), updatedAt: Timestamp.fromMillis(now()) });
      return true;
    });
  }

  const loop = (async () => {
    while (!stopped && !lost) {
      const waitMs = Math.min(intervalMs, Math.max(0, leaseUntil - now()));
      if (waitMs === 0) {
        lost = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      if (stopped) break;
      try {
        if (!(await renew())) {
          lost = true;
          break;
        }
        leaseUntil = now() + input.leaseMs;
      } catch {
        if (now() >= leaseUntil) lost = true;
      }
    }
  })();

  return {
    async assertCurrent() {
      if (lost || now() >= leaseUntil) throw new OutboxLeaseLostError();
    },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

export async function runBoundedWorkers<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R> | undefined> = new Array(items.length);
  let next = 0;
  async function runWorker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results as Array<PromiseSettledResult<R>>;
}

export function createOutboxSummary(domain: OutboxProcessorSummary["domain"], started: number, fields: Partial<OutboxProcessorSummary> = {}): OutboxProcessorSummary {
  const completedAt = Date.now();
  return {
    domain,
    status: "completed",
    candidatesSelected: 0,
    pagesRead: 0,
    claimAttempts: 0,
    claimedOperations: 0,
    completedOperations: 0,
    pendingOperations: 0,
    manualReviewOperations: 0,
    skippedOperations: 0,
    operationErrors: 0,
    deadlineReached: false,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, completedAt - started),
    ...fields,
  };
}
