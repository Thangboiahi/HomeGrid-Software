import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

type RolePlaceholderProps = {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
};

export function RolePlaceholder({
  eyebrow,
  title,
  description,
  href,
  linkLabel,
}: RolePlaceholderProps) {
  return (
    <main className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto grid min-h-[calc(100vh-76px)] max-w-6xl content-center px-6 py-16">
        <div className="max-w-2xl rounded-3xl border border-[var(--line)] bg-white p-8 shadow-sm sm:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--brand)]">{eyebrow}</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[var(--muted)]">{description}</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <span className="rounded-full bg-[#f1f4f2] px-3 py-1.5 text-xs font-semibold text-[#4b5d54]">Foundation placeholder</span>
            <Link className="text-sm font-semibold text-[var(--brand)] underline-offset-4 hover:underline" href={href}>
              {linkLabel} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
