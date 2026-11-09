import type { Metadata } from "next";
import Link from "next/link";
import { getSimulatorEnvironment } from "@/domain/simulator/configuration";
import { SuperAdminDeviceRegistry } from "@/features/device-registry/device-registry-views";
import { enforcePageRole } from "@/services/auth/page-access";

export const metadata: Metadata = { title: "Super Admin" };

export default async function SuperAdminPage() {
  await enforcePageRole("superAdmin");
  return <>
    {getSimulatorEnvironment() && <div className="border-b border-[var(--line)] bg-white px-5 py-3 sm:px-8"><div className="mx-auto max-w-6xl">
      <Link href="/super-admin/simulator" className="text-sm font-semibold text-[var(--brand-dark)]">Open development device simulator</Link>
    </div></div>}
    <SuperAdminDeviceRegistry />
  </>;
}
