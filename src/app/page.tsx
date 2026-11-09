import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

const experiences = [
  {
    title: "Customer",
    description: "A home for household members and their connected living experience.",
    href: "/customer",
  },
  {
    title: "Installer",
    description: "A workspace for installations assigned to your team.",
    href: "/installer",
  },
  {
    title: "Super Admin",
    description: "Tools for operating and managing the HomeGrid platform.",
    href: "/super-admin",
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto grid min-h-[calc(100vh-76px)] max-w-6xl content-center gap-12 px-6 py-16 lg:grid-cols-[1fr_0.9fr] lg:items-center lg:gap-20">
        <div className="max-w-xl">
          <p className="mb-5 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand)]">
            HomeGrid
          </p>
          <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Smart living.
            <br />
            Reliable by design.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-[var(--muted)]">
            A thoughtful foundation for connected homes, the people who live in them, and the teams who support them.
          </p>
          <Link
            className="mt-8 inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--brand)] px-6 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-dark)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--brand)]"
            href="/auth"
          >
            Continue to HomeGrid
          </Link>
        </div>

        <div className="grid gap-3" aria-label="HomeGrid experiences">
          {experiences.map((experience, index) => (
            <Link
              className="group flex items-center justify-between gap-5 rounded-2xl border border-[var(--line)] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#b6cfc2] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] sm:p-6"
              href={experience.href}
              key={experience.title}
            >
              <span className="flex items-start gap-4">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-[#eaf4ee] text-sm font-semibold text-[var(--brand)]">
                  0{index + 1}
                </span>
                <span>
                  <span className="block text-lg font-semibold">{experience.title}</span>
                  <span className="mt-1 block max-w-sm text-sm leading-6 text-[var(--muted)]">
                    {experience.description}
                  </span>
                </span>
              </span>
              <span aria-hidden="true" className="text-xl text-[var(--brand)] transition-transform group-hover:translate-x-1">
                →
              </span>
            </Link>
          ))}
        </div>
      </section>
      <footer className="border-t border-[var(--line)] px-6 py-5 text-center text-sm text-[var(--muted)]">
        HomeGrid · Smart living. Reliable by design.
      </footer>
    </main>
  );
}
