import { NextResponse } from "next/server";
import { AccountOperationConflictError, AuthorizationError } from "@/services/auth/authorization";

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AccountOperationConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof AuthorizationError) {
    const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : 404;
    return NextResponse.json({ error: error.message }, { status, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  console.error("HomeGrid protected request failed.", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: "Request could not be completed." }, { status: 500, headers: { "cache-control": "no-store" } });
}

export function readSessionCookie(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("homegrid_session="));
  return match ? match.slice("homegrid_session=".length) : "";
}

export function assertTrustedMutationOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const configured = process.env.APP_ORIGIN;
  if (!origin || !configured) throw new AuthorizationError("forbidden", "Forbidden.");
  try {
    const expected = new URL(configured);
    if (process.env.NODE_ENV === "production" && expected.protocol !== "https:") throw new Error("HTTPS is required.");
    if (new URL(origin).origin !== expected.origin) throw new Error("Origin mismatch.");
  } catch {
    throw new AuthorizationError("forbidden", "Forbidden.");
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new TypeError("JSON is required.");
  const value: unknown = await request.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("JSON object is required.");
  return value as Record<string, unknown>;
}

export async function readOptionalManualRetry(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const body = await readJsonObject(request);
  if (Object.keys(body).some((key) => key !== "retryManualReview") ||
      (body.retryManualReview !== undefined && typeof body.retryManualReview !== "boolean")) {
    throw new TypeError("Invalid account operation retry request.");
  }
  return body.retryManualReview === true;
}
