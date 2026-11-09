import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, readSessionCookie } from "@/services/auth/api-response";
import { readCustomerHouseholds } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await readCustomerHouseholds(readSessionCookie(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
