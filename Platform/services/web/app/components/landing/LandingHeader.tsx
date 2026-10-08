"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { BrandMark } from "@/app/components/shell/BrandMark";
import { GetStartedLink, SignInLink } from "./AuthCta";
import { LANDING_SECTIONS } from "./sections";

/** Sticky top navigation; below md the section links fold into a menu. */
export default function LandingHeader() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 bg-navy-900/95 backdrop-blur border-b border-white/5 text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-6">
        <Link href="/" className="rounded-lg" aria-label="Vzoniq home">
          <BrandMark tone="dark" compact />
        </Link>

        <nav aria-label="Primary" className="hidden md:flex items-center gap-1 text-sm">
          {LANDING_SECTIONS.map((s) => (
            <a key={s.href} href={s.href} className="px-3 py-2 rounded-lg text-navy-200 hover:text-white hover:bg-white/5 transition-colors">
              {s.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SignInLink className="hidden sm:inline-flex h-9 px-3.5 items-center rounded-lg text-sm font-medium text-navy-200 hover:text-white hover:bg-white/5 transition-colors" />
          <GetStartedLink className="hidden sm:inline-flex" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="md:hidden h-9 w-9 flex items-center justify-center rounded-lg text-navy-200 hover:text-white hover:bg-white/5"
          >
            {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {open && (
        <div id="landing-menu" className="md:hidden border-t border-white/5 px-4 pb-4">
          <nav aria-label="Primary" className="flex flex-col py-2">
            {LANDING_SECTIONS.map((s) => (
              <a
                key={s.href}
                href={s.href}
                onClick={() => setOpen(false)}
                className="px-2 py-2.5 rounded-lg text-sm text-navy-200 hover:text-white hover:bg-white/5"
              >
                {s.label}
              </a>
            ))}
          </nav>
          <div className="flex flex-col gap-2 pt-2 border-t border-white/5 sm:hidden">
            <SignInLink className="h-10 flex items-center justify-center rounded-lg text-sm font-medium text-white ring-1 ring-white/15 hover:bg-white/5" />
            <GetStartedLink className="h-10" />
          </div>
        </div>
      )}
    </header>
  );
}
