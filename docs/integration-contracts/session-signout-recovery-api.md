# Session sign-out manual-review recovery API

**Status:** Implemented in SW-01.8D  
**Route:** `POST /api/admin/session-signouts/{operationId}/retry`

## Request

- Requires the existing active HomeGrid session cookie and the server-side `users.manage` permission. In the current permission matrix, that permission is granted to Super Admin.
- Requires an `Origin` matching configured `APP_ORIGIN`. Production configuration must use HTTPS.
- The path operation ID must be the lowercase 64-character SHA-256 digest used by `sessionSignOutOperations`.
- No request body is accepted. In particular, the client cannot supply a UID, role, permission, reason, or operation state.
- The target UID and operation state are read only from the existing server-side operation document.

## Results

| HTTP | Meaning |
| --- | --- |
| `202` | A `manualReview` operation was transactionally requeued to pending. Response includes opaque operation ID, status and manual review/retry count. |
| `200` | Operation is already completed; it is unchanged. |
| `400` | Invalid operation ID or a body was supplied. |
| `401` | Missing or invalid active session. |
| `403` | Origin is not trusted or the operator lacks `users.manage`. |
| `404` | No matching operation exists. |
| `409` | Operation is pending or processing; no mutation or duplicate retry audit is created. |
| `500` | Firestore or audit transaction failed. The atomic transaction leaves the operation in manual review. |

## Transaction and processing

The server-only coordinator transaction reads the existing operation and acts only while it is `manualReview`. It preserves the operation ID, bound UID, original requester, actor role and correlation ID; resets the automatic attempt count; increments the existing `manualReviewCount`; sets `nextAttemptAt` to the current time; and removes only lease and failure fields. It creates a deterministic `auth.session.sign_out.retry-requested` audit event in the same transaction. The deterministic event ID is `{operationId}-manual-retry-{manualReviewCount}`. Concurrent requests serialize on the operation; after the first commits, later requests see `pending` and return `409` without adding another event.

The audit schema has no reason/reference field. The endpoint accepts no free-text metadata. Actor UID and role are derived from the verified server session. The API itself makes no Firebase Auth call. The existing SW-01.8C bounded processor claims the pending operation using its one-minute lease and fencing token, then revokes refresh tokens for the UID stored in the operation. Existing failure/backoff behavior remains in force and may return the operation to `manualReview`.

This route does not enable Firebase Auth, restore HomeGrid access, alter roles, write account-access operations, or provide general operation editing. Client Firestore rules remain deny-all. No production worker or deployment is part of this endpoint.
