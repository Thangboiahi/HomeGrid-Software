import { NextResponse } from "next/server";
import { errorResponse } from "@/services/auth/api-response";
import { SimulatorUnavailableError } from "@/services/simulator/runtime";

export function simulatorErrorResponse(error: unknown): NextResponse {
  if (error instanceof SimulatorUnavailableError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
  }
  return errorResponse(error);
}
