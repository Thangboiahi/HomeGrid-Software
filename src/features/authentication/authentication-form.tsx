"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { registerWithEmailPassword, signInWithEmailPassword, signOutHomeGrid } from "@/services/auth/email-password";

type Mode = "signIn" | "register";

function readableAuthError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (error instanceof Error && error.message.startsWith("This account does not currently have HomeGrid access.")) {
    return error.message;
  }
  switch (code) {
    case "auth/email-already-in-use": return "An account already uses this email. Try signing in instead.";
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/weak-password": return "Choose a longer password.";
    case "auth/too-many-requests": return "Too many attempts. Wait a little, then try again.";
    case "auth/network-request-failed": return "We could not reach the authentication service. Check your connection and try again.";
    case "auth/user-disabled": return "This account is unavailable. Contact your administrator.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Email or password was not accepted. Check your details and try again.";
    default: return error instanceof Error && error.message.includes("HomeGrid server session")
      ? "We could not start your HomeGrid session. Please try again."
      : "Authentication could not be completed. Please try again.";
  }
}

export function AuthenticationForm() {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as { redirectTo?: unknown };
      })
      .then((session) => {
        if (!cancelled && typeof session?.redirectTo === "string") setRedirectTo(session.redirectTo);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setCheckingSession(false); });
    return () => { cancelled = true; };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      if (mode === "register") {
        await registerWithEmailPassword(email.trim(), password);
        setPassword("");
        setMode("signIn");
        setMessage("Your HomeGrid account was created. A HomeGrid administrator must provision your access before you can sign in to the application.");
        return;
      }

      await signInWithEmailPassword(email.trim(), password);
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        await signOutHomeGrid().catch(() => undefined);
        throw new Error(response.status === 403
          ? "This account does not currently have HomeGrid access. Contact your administrator."
          : "The HomeGrid session could not be verified. Please sign in again.");
      }
      const result = await response.json() as { redirectTo?: unknown };
      if (typeof result.redirectTo !== "string" || !result.redirectTo.startsWith("/")) {
        await signOutHomeGrid().catch(() => undefined);
        throw new Error("The HomeGrid session could not be verified. Please sign in again.");
      }
      window.location.assign(result.redirectTo);
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await signOutHomeGrid();
      setRedirectTo(null);
      setMessage("You have signed out of HomeGrid.");
    } catch {
      setError("We could not confirm that all HomeGrid sessions were invalidated. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "mt-1.5 min-h-12 w-full rounded-xl border border-[var(--line)] bg-white px-4 text-base outline-none transition focus:border-[var(--brand)] focus:ring-2 focus:ring-[#18765f33]";
  const buttonClass = "inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--brand)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--brand-dark)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:cursor-wait disabled:opacity-60";

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col justify-center">
        <Link href="/" className="mb-8 inline-flex w-fit items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--brand)]">
          <span aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-[var(--brand)] text-white">
            <svg fill="none" height="22" viewBox="0 0 24 24" width="22"><path d="m3.5 10 8.5-7 8.5 7v9.25a1.25 1.25 0 0 1-1.25 1.25h-14A1.25 1.25 0 0 1 4 19.25V10M9 20.5v-7h6v7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
          </span>
          <span><span className="block text-lg font-semibold tracking-tight">HomeGrid</span><span className="block text-xs text-[var(--muted)]">Smart living. Reliable by design.</span></span>
        </Link>

        <section className="grid overflow-hidden rounded-3xl border border-[var(--line)] bg-white shadow-sm md:grid-cols-[0.9fr_1.1fr]">
          <aside className="flex flex-col justify-between bg-[#eaf4ee] p-7 sm:p-10">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand)]">Welcome to HomeGrid</p>
              <h1 className="mt-5 max-w-sm text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">A more reliable way to live connected.</h1>
              <p className="mt-4 max-w-sm text-sm leading-6 text-[var(--muted)]">Sign in with your HomeGrid account. Access is verified securely by HomeGrid before you continue.</p>
            </div>
            <p className="mt-12 text-sm font-medium text-[var(--brand-dark)]">Smart living. Reliable by design.</p>
          </aside>

          <div className="p-7 sm:p-10">
            {checkingSession ? <p role="status" className="py-12 text-center text-sm text-[var(--muted)]">Checking your HomeGrid session…</p> : redirectTo ? (
              <div className="py-4">
                <p className="text-sm font-semibold text-[var(--brand)]">You’re signed in</p>
                <h2 className="mt-2 text-2xl font-semibold">Continue to HomeGrid</h2>
                <p className="mt-2 text-sm text-[var(--muted)]">Your active session has been verified.</p>
                <button className={`${buttonClass} mt-7`} disabled={busy} onClick={() => window.location.assign(redirectTo)} type="button">Continue</button>
                <button className="mt-3 min-h-11 w-full rounded-xl border border-[var(--line)] px-4 text-sm font-semibold hover:bg-[var(--background)] disabled:opacity-60" disabled={busy} onClick={() => void signOut()} type="button">{busy ? "Signing out…" : "Sign out"}</button>
              </div>
            ) : (
              <>
                <div className="mb-7 flex rounded-xl bg-[var(--background)] p-1" role="tablist" aria-label="Authentication options">
                  <button className={`min-h-10 flex-1 rounded-lg text-sm font-semibold ${mode === "signIn" ? "bg-white shadow-sm" : "text-[var(--muted)]"}`} onClick={() => { setMode("signIn"); setError(""); setMessage(""); }} role="tab" aria-selected={mode === "signIn"} type="button">Sign in</button>
                  <button className={`min-h-10 flex-1 rounded-lg text-sm font-semibold ${mode === "register" ? "bg-white shadow-sm" : "text-[var(--muted)]"}`} onClick={() => { setMode("register"); setError(""); setMessage(""); }} role="tab" aria-selected={mode === "register"} type="button">Create account</button>
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">{mode === "signIn" ? "Sign in to your account" : "Create your account"}</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{mode === "signIn" ? "Use the email and password associated with your HomeGrid access." : "Registration creates an account only. HomeGrid access is granted separately by an administrator."}</p>

                <form className="mt-7 grid gap-5" onSubmit={submit}>
                  <label className="text-sm font-semibold">Email address
                    <input className={inputClass} autoComplete="email" autoCapitalize="none" autoCorrect="off" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
                  </label>
                  <label className="text-sm font-semibold">Password
                    <input className={inputClass} autoComplete={mode === "signIn" ? "current-password" : "new-password"} minLength={6} name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
                  </label>
                  {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm leading-5 text-red-800" role="alert">{error}</p>}
                  {message && <p className="rounded-xl bg-[#eaf4ee] px-4 py-3 text-sm leading-5 text-[var(--brand-dark)]" role="status">{message}</p>}
                  <button className={buttonClass} disabled={busy} type="submit">{busy ? "Please wait…" : mode === "signIn" ? "Sign in securely" : "Create account"}</button>
                </form>
              </>
            )}
            <p className="mt-7 text-center text-xs leading-5 text-[var(--muted)]">HomeGrid verifies account status and application access before opening protected areas.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
