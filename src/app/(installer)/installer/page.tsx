import type { Metadata } from "next";
import { InstallerDeviceRegistry } from "@/features/device-registry/device-registry-views";
import { enforcePageRole } from "@/services/auth/page-access";

export const metadata: Metadata = { title: "Installer" };

export default async function InstallerPage() {
  await enforcePageRole("installer");
  return <InstallerDeviceRegistry />;
}
