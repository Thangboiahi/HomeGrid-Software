import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { readDeviceById } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  try {
    const { deviceId } = await context.params;
    return NextResponse.json(await readDeviceById(deviceId, readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
