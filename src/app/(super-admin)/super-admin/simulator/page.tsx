import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeviceSimulatorConsole } from "@/features/device-simulator/device-simulator-console";
import { getSimulatorEnvironment } from "@/domain/simulator/configuration";
import { enforcePageRole } from "@/services/auth/page-access";

export const metadata: Metadata = { title: "Development Device Simulator" };
export const dynamic = "force-dynamic";

export default async function DeviceSimulatorPage() {
  if (!getSimulatorEnvironment()) notFound();
  await enforcePageRole("superAdmin");
  return <>
    <div className="border-b border-[var(--line)] bg-white px-5 py-3 sm:px-8">
      <div className="mx-auto max-w-6xl"><Link href="/super-admin" className="text-sm font-medium text-[var(--brand-dark)]">← Back to Super Admin registry</Link></div>
    </div>
    <DeviceSimulatorConsole />
  </>;
}
