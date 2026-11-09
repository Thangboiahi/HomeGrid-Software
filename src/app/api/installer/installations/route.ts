import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { readAssignedInstallations } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await readAssignedInstallations(readSessionCookie(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
