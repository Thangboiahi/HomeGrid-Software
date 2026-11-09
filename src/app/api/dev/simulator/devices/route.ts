import { NextResponse, type NextRequest } from "next/server";
import { assertTrustedMutationOrigin, readJsonObject, readSessionCookie } from "@/services/auth/api-response";
import { createSimulatedDevice, readSimulatedDevices } from "@/services/simulator/operations";
import { requireSimulatorConfiguration } from "@/services/simulator/runtime";
import { simulatorErrorResponse } from "@/app/api/dev/simulator/response";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireSimulatorConfiguration();
    return NextResponse.json(await readSimulatedDevices(readSessionCookie(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return simulatorErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    requireSimulatorConfiguration();
    assertTrustedMutationOrigin(request);
    const body = await readJsonObject(request);
    const created = await createSimulatedDevice(body, readSessionCookie(request));
    return NextResponse.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return simulatorErrorResponse(error); }
}
