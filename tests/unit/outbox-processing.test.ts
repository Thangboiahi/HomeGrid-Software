import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOutboxRunBudget, runBoundedWorkers } from "@/services/security/outbox-processing";

test("outbox budgets establish independent bounded defaults and accept explicit limits", () => {
  const budget = resolveOutboxRunBudget({ maxCandidates: 12, maxClaimedOperations: 3, maxPages: 2, pageSize: 6, concurrency: 2, maxRunMs: 5000, claimReserveMs: 500 }, 1000);
  assert.equal(budget.maxCandidates, 12);
  assert.equal(budget.maxClaimedOperations, 3);
  assert.equal(budget.maxPages, 2);
  assert.equal(budget.pageSize, 6);
  assert.equal(budget.concurrency, 2);
  assert.equal(budget.deadlineAt, 6000);
  assert.equal(budget.claimReserveMs, 500);
  assert.throws(() => resolveOutboxRunBudget({ concurrency: 0 }), /positive/);
});

test("bounded workers continue after an individual operation failure", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await runBoundedWorkers([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (value === 2) throw new Error("operation failed");
    return value * 2;
  });
  assert.equal(maximumActive, 2);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
