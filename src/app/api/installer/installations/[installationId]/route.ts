import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requireRole } from "@/services/auth/authorization";
import { readAssignedInstallation, updateAssignedInstallation } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ installationId: string }> }) {
  try {
    await requireRole("installer", readSessionCookie(request));
    const { installationId } = await context.params;
    return NextResponse.json(await readAssignedInstallation(installationId, readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: NextRequest, context: { params: Promise<{ installationId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requireRole("installer", readSessionCookie(request));
    const { installationId } = await context.params;
    const body = await readJsonObject(request);
    if (body.state !== "inProgress" && body.state !== "completed") throw new TypeError("Invalid installation state.");
    if (body.completionNote !== undefined && typeof body.completionNote !== "string") throw new TypeError("Invalid completion information.");
    return NextResponse.json(await updateAssignedInstallation(installationId, body.state, readSessionCookie(request), body.completionNote as string | undefined));
  } catch (error) { return errorResponse(error); }
}
