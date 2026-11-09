import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { readDeviceRegistryOverview, registerDevice } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await readDeviceRegistryOverview(readSessionCookie(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("devices.register", readSessionCookie(request));
    const body = await readJsonObject(request);
    if (typeof body.productDefinitionId !== "string" || (body.kind !== "simulated" && body.kind !== "physical")) throw new TypeError("Invalid device registration.");
    return NextResponse.json(await registerDevice({ productDefinitionId: body.productDefinitionId, kind: body.kind }, readSessionCookie(request)), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
