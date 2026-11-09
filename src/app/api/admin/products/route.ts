import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { createProductDefinition, readProductDefinitions } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await readProductDefinitions(readSessionCookie(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("products.manage", readSessionCookie(request));
    const body = await readJsonObject(request);
    if (typeof body.productCode !== "string" || typeof body.displayName !== "string") throw new TypeError("Invalid product definition.");
    return NextResponse.json(await createProductDefinition({ productCode: body.productCode, displayName: body.displayName }, readSessionCookie(request)), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
