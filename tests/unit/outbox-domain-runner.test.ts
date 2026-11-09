import assert from "node:assert/strict";
import { test } from "node:test";
import { runOutboxDomains } from "@/services/security/outbox-domain-runner";

test("outbox domain failure does not suppress the other processor", async () => {
  let sessionRan = false;
  const result = await runOutboxDomains({
    accountAccess: async () => { throw new Error("query failed"); },
    sessionSignOut: async () => { sessionRan = true; return "completed"; },
  });
  assert.equal(sessionRan, true);
  assert.equal(result.accountAccess.status, "rejected");
  assert.deepEqual(result.sessionSignOut, { status: "fulfilled", value: "completed" });
});
