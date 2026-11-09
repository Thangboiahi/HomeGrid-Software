import type { Metadata } from "next";
import { AuthenticationForm } from "@/features/authentication/authentication-form";

export const metadata: Metadata = { title: "Authentication" };

export default function AuthenticationPage() {
  return (
    <AuthenticationForm />
  );
}
