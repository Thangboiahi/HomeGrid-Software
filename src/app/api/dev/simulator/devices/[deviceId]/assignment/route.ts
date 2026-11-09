import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { associateSimulatedDevice } from "@/services/simulator/operations";
import { requireSimulatorConfiguration } from "@/services/simulator/runtime";
import { simulatorErrorResponse } from "@/app/api/dev/simulator/response";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  try {
    requireSimulatorConfiguration();
    assertTrustedMutationOrigin(request);
    const { deviceId } = await context.params;
    const body = await readJsonObject(request);
    return NextResponse.json(await associateSimulatedDevice(deviceId, body, readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return simulatorErrorResponse(error); }
}
