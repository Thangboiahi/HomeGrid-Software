import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { assignInstaller } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ installationId: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("installations.manage", readSessionCookie(request));
    const { installationId } = await context.params;
    const body = await readJsonObject(request);
    if (typeof body.installerUid !== "string") throw new TypeError("Installer UID is required.");
    return NextResponse.json(await assignInstaller(installationId, body.installerUid, readSessionCookie(request)));
  } catch (error) { return errorResponse(error); }
}
