import type { Metadata } from "next";
import { CustomerDeviceRegistry } from "@/features/device-registry/device-registry-views";
import { enforcePageRole } from "@/services/auth/page-access";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage() {
  await enforcePageRole("customer");
  return <CustomerDeviceRegistry />;
}
