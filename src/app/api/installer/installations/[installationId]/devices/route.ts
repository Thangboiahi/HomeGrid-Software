import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { readAssignedInstallationDevices } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ installationId: string }> }) {
  try {
    const { installationId } = await context.params;
    return NextResponse.json(await readAssignedInstallationDevices(installationId, readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
