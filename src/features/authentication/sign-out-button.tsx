"use client";

import { useState } from "react";
import { signOutHomeGrid } from "@/services/auth/email-password";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await signOutHomeGrid();
      window.location.assign(new URL("/auth", window.location.origin).toString());
    } catch {
      setError("We could not confirm that all HomeGrid sessions were invalidated. Please try again.");
      setBusy(false);
    }
  }

  return <div className="flex items-center gap-3">
    {error && <span role="alert" className="max-w-56 text-xs text-red-700">{error}</span>}
    <button type="button" onClick={() => void signOut()} disabled={busy} className="min-h-10 rounded-full border border-[var(--line)] px-4 text-sm font-semibold text-[var(--brand-dark)] hover:bg-[var(--background)] disabled:opacity-60">
      {busy ? "Signing out…" : "Sign out"}
    </button>
  </div>;
}
