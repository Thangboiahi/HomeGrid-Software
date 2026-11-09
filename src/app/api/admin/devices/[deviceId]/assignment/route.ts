import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { assignDevice } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("devices.assign", readSessionCookie(request));
    const { deviceId } = await context.params;
    const body = await readJsonObject(request);
    if (body.householdId !== undefined && typeof body.householdId !== "string") throw new TypeError("Invalid household ID.");
    if (body.installationId !== undefined && typeof body.installationId !== "string") throw new TypeError("Invalid installation ID.");
    return NextResponse.json(await assignDevice(deviceId, {
      ...(typeof body.householdId === "string" ? { householdId: body.householdId } : {}),
      ...(typeof body.installationId === "string" ? { installationId: body.installationId } : {}),
    }, readSessionCookie(request)));
  } catch (error) { return errorResponse(error); }
}
