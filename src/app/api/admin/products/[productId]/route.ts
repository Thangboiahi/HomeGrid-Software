import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { setProductDefinitionState } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("products.manage", readSessionCookie(request));
    const { productId } = await context.params;
    const body = await readJsonObject(request);
    if (body.state !== "active" && body.state !== "retired") throw new TypeError("Invalid product state.");
    return NextResponse.json(await setProductDefinitionState(productId, body.state, readSessionCookie(request)));
  } catch (error) { return errorResponse(error); }
}
