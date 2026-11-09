import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { readCustomerDevices } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ householdId: string }> }) {
  try {
    const { householdId } = await context.params;
    return NextResponse.json(await readCustomerDevices(householdId, readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
