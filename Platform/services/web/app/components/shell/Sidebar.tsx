"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { NAV_SECTIONS, SYSTEM_ITEMS, isActive, type NavItem } from "./navigation";

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string | null; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-sm transition-colors ${
        active
          ? "bg-navy-700 text-white font-medium shadow-[inset_2px_0_0_0_#3a74ec]"
          : "text-navy-200 hover:text-white hover:bg-navy-800"
      }`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${active ? "text-brand-200" : "text-navy-300 group-hover:text-navy-200"}`}
        aria-hidden="true"
      />
      {item.label}
    </Link>
  );
}

function SidebarContent({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-full bg-navy-900 text-white">
      <div className="h-16 px-4 flex items-center justify-between border-b border-white/5">
        <Link href="/" onClick={onNavigate} className="min-w-0" aria-label="Vzoniq dashboard">
          <BrandMark tone="dark" />
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="p-1.5 rounded-md text-navy-200 hover:text-white hover:bg-navy-800"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Main">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="px-2.5 mb-1.5 text-2xs font-semibold uppercase tracking-wider text-navy-300/80">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-3 py-3 border-t border-white/5 space-y-0.5">
        {SYSTEM_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

/** Persistent on large screens; a drawer (open/onClose) below them. */
export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-60 z-30">
        <SidebarContent />
      </aside>
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-navy-950/60" onClick={onClose} aria-hidden="true" />
          <div className="relative w-72 max-w-[85vw] h-full shadow-pop">
            <SidebarContent onNavigate={onClose} onClose={onClose} />
          </div>
        </div>
      )}
    </>
  );
}
