import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { setFirmwareReleaseState } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ releaseId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("firmwareReleases.manage", readSessionCookie(request));
    const { releaseId } = await context.params;
    const body = await readJsonObject(request);
    if (body.state !== "approved" && body.state !== "retired") throw new TypeError("Invalid firmware release state.");
    return NextResponse.json(await setFirmwareReleaseState(releaseId, body.state, readSessionCookie(request)));
  } catch (error) { return errorResponse(error); }
}
