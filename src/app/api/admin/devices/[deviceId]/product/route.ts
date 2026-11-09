import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { reassignDeviceProduct } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    const cookie = readSessionCookie(request);
    await requirePermission("devices.assign", cookie);
    await requirePermission("products.manage", cookie);
    const { deviceId } = await context.params;
    const body = await readJsonObject(request);
    if (typeof body.productDefinitionId !== "string") throw new TypeError("Product definition ID is required.");
    return NextResponse.json(await reassignDeviceProduct(deviceId, body.productDefinitionId, cookie));
  } catch (error) { return errorResponse(error); }
}
