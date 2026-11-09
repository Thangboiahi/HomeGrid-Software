import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { requestSessionSignOutManualRetry } from "@/services/auth/session-signout-operations";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    // Manual recovery is identified only by the existing opaque digest in the URL.
    if (request.body) throw new TypeError("A request body is not accepted.");
    const { operationId } = await context.params;
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new TypeError("Invalid session sign-out operation ID.");

    const result = await requestSessionSignOutManualRetry(operationId, readSessionCookie(request));
    switch (result.status) {
      case "retryRequested":
        return response({ operationId, status: "pending", manualReviewCount: result.manualReviewCount }, 202);
      case "alreadyPending":
        return response({ error: "A retry is already pending." }, 409);
      case "processing":
        return response({ error: "The operation is already processing." }, 409);
      case "completed":
        return response({ operationId, status: "completed", alreadyCompleted: true }, 200);
      case "notFound":
        return response({ error: "Session sign-out operation not found." }, 404);
    }
  } catch (error) {
    return errorResponse(error);
  }
}

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store, max-age=0" } });
}
