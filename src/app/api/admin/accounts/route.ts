import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, errorResponse, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { requirePermission } from "@/services/auth/authorization";
import { provisionAccount, readManagedAccounts } from "@/services/security/protected-operations";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await readManagedAccounts(readSessionCookie(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    await requirePermission("users.manage", readSessionCookie(request));
    const body = await readJsonObject(request);
    if (typeof body.uid !== "string" || (body.role !== "customer" && body.role !== "installer")) throw new TypeError("Invalid account provisioning request.");
    return NextResponse.json(await provisionAccount(body.uid, body.role, readSessionCookie(request)), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
