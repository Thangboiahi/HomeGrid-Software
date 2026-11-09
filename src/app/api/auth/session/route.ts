import { NextRequest, NextResponse } from "next/server";
import { getFirebaseAdminAuth, getFirebaseAdminFirestore } from "@/infrastructure/firebase/admin";
import { recordAuditEvent, resolveAuditActorRole } from "@/services/audit/server-audit";
import { AuthorizationError, requireAuthenticatedUser } from "@/services/auth/authorization";
import { errorResponse } from "@/services/auth/api-response";
import { createSessionSignOutCoordinator, sessionSignOutOperationId } from "@/services/auth/session-signout-operations";
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  sessionCookieOptions,
} from "@/services/auth/server-session";

export const runtime = "nodejs";

const ROLE_HOME = {
  customer: "/customer",
  installer: "/installer",
  superAdmin: "/super-admin",
} as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requireAuthenticatedUser(request.cookies.get(SESSION_COOKIE_NAME)?.value ?? "");
    return json({ redirectTo: ROLE_HOME[principal.role] });
  } catch (error) {
    return errorResponse(error);
  }
}

function hasTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const appOrigin = process.env.APP_ORIGIN;
  if (!origin || !appOrigin) return false;

  try {
    const configuredOrigin = new URL(appOrigin);
    if (process.env.NODE_ENV === "production" && configuredOrigin.protocol !== "https:") {
      return false;
    }
    return new URL(origin).origin === configuredOrigin.origin;
  } catch {
    return false;
  }
}

async function readLimitedBody(request: Request, limit: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("Request body exceeds the session endpoint limit.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Unsupported media type" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return json({ error: "Request too large" }, 413);
  }

  let idToken: unknown;
  try {
    const body: unknown = JSON.parse(await readLimitedBody(request, 16_384));
    if (typeof body !== "object" || body === null || !("idToken" in body)) {
      return json({ error: "Invalid request" }, 400);
    }
    idToken = body.idToken;
  } catch (error) {
    if (error instanceof RangeError) return json({ error: "Request too large" }, 413);
    return json({ error: "Invalid JSON" }, 400);
  }

  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > 16_000) {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    const auth = getFirebaseAdminAuth();
    const decoded = await auth.verifyIdToken(idToken);
    const authTime = Number(decoded.auth_time);
    const ageSeconds = Date.now() / 1000 - authTime;
    if (!Number.isFinite(authTime) || ageSeconds < 0 || ageSeconds > 5 * 60) {
      return json({ error: "Recent sign-in required" }, 401);
    }

    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    });
    // A valid Firebase identity alone is not sufficient for HomeGrid access.
    // Validate the live account, profile and authoritative access record before issuing a cookie.
    const principal = await requireAuthenticatedUser(sessionCookie);
    await recordAuditEvent({
      actorUid: principal.uid,
      actorRole: principal.role,
      action: "auth.session.created",
      resourceType: "authSession",
      resourceId: decoded.uid,
      outcome: "success",
    });
    const response = json({ ok: true });
    response.cookies.set(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return json({ error: "HomeGrid access is not active. Contact your administrator if you need access." }, 403);
    }
    return json({ error: "Authentication failed" }, 401);
  }
}

export async function DELETE(request: NextRequest) {
  if (!hasTrustedOrigin(request)) return json({ error: "Forbidden" }, 403);

  const existingCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  let requestedOperationId: string | undefined;
  if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    try {
      const body: unknown = JSON.parse(await readLimitedBody(request, 1024));
      if (typeof body !== "object" || body === null || !("operationId" in body) || typeof body.operationId !== "string" || !/^[a-f0-9]{64}$/.test(body.operationId)) {
        return json({ error: "Invalid sign-out recovery request." }, 400);
      }
      requestedOperationId = body.operationId;
    } catch {
      return json({ error: "Invalid sign-out recovery request." }, 400);
    }
  }
  if (existingCookie && requestedOperationId && requestedOperationId !== sessionSignOutOperationId(existingCookie)) {
    return json({ error: "Sign-out recovery does not match this session." }, 400);
  }
  if (!existingCookie && !requestedOperationId) {
    const response = json({ ok: true });
    response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), expires: new Date(0), maxAge: 0 });
    return response;
  }

  let status = 200;
  let body: Record<string, unknown> = { ok: true };
  let recoveryOperationId = existingCookie ? sessionSignOutOperationId(existingCookie) : requestedOperationId;
  if (recoveryOperationId) {
    try {
      const auth = getFirebaseAdminAuth();
      const db = getFirebaseAdminFirestore();
      const coordinator = createSessionSignOutCoordinator({ db, auth });
      let operation = await coordinator.get(recoveryOperationId);

      // A prior request may already have revoked this cookie. The stored operation
      // lets recovery proceed without relying on revocation-checked verification.
      if (!operation) {
        if (!existingCookie) {
          status = 404;
          body = { error: "Sign-out recovery operation not found." };
          recoveryOperationId = undefined;
          throw new Error("Sign-out recovery operation not found.");
        }
        let claims;
        try {
          claims = await auth.verifySessionCookie(existingCookie, false);
        } catch {
          // No valid session and no durable operation exists; just clear the browser cookie.
          const response = json({ ok: true });
          response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), expires: new Date(0), maxAge: 0 });
          return response;
        }
        const actorRole = await resolveAuditActorRole(claims.uid);
        await coordinator.begin({ operationId: recoveryOperationId, uid: claims.uid, authTime: Number(claims.auth_time), actorRole });
        operation = await coordinator.get(recoveryOperationId);
      }

      if (!operation) throw new Error("Sign-out intent was not durably stored.");
      const result = await coordinator.process(recoveryOperationId);
      if (result.status !== "completed") {
        status = 503;
        body = { error: "Session invalidation could not be confirmed.", operationId: recoveryOperationId };
      }
    } catch {
      if (status !== 404) {
        status = 503;
        body = { error: "Session invalidation could not be confirmed.", ...(recoveryOperationId ? { operationId: recoveryOperationId } : {}) };
      }
    }
  }

  const response = json(body, status);
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), expires: new Date(0), maxAge: 0 });
  return response;
}
