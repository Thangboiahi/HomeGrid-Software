import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readOptionalManualRetry, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { suspendAccount } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ uid: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("users.manage", readSessionCookie(request));
    const { uid } = await context.params;
    const result = await suspendAccount(uid, readSessionCookie(request), await readOptionalManualRetry(request));
    return NextResponse.json(result, { status: result.status === "completed" ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
