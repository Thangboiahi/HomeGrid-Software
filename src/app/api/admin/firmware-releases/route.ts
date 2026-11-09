import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { createFirmwareRelease } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("firmwareReleases.manage", readSessionCookie(request));
    const body = await readJsonObject(request);
    if (typeof body.productDefinitionId !== "string" || typeof body.versionLabel !== "string") throw new TypeError("Invalid firmware release metadata.");
    return NextResponse.json(await createFirmwareRelease({ productDefinitionId: body.productDefinitionId, versionLabel: body.versionLabel }, readSessionCookie(request)), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
