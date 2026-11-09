import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-[var(--line)] bg-[var(--background)]/90">
      <div className="mx-auto flex h-[76px] max-w-6xl items-center justify-between px-6">
        <Link aria-label="HomeGrid home" className="flex items-center gap-3" href="/">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-[var(--brand)] text-white">
            <svg fill="none" height="20" viewBox="0 0 24 24" width="20">
              <path d="m3.5 10 8.5-7 8.5 7v9.25a1.25 1.25 0 0 1-1.25 1.25h-14A1.25 1.25 0 0 1 4 19.25V10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              <path d="M9 20.5v-7h6v7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight">HomeGrid</span>
        </Link>
        <Link className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--brand)] transition hover:bg-[#eaf4ee] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]" href="/auth">
          Sign in
        </Link>
      </div>
    </header>
  );
}
