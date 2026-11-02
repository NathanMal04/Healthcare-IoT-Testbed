"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useFocusTrap } from "@/app/components/ui/useFocusTrap";
import { BrandLogo, BrandMark } from "./BrandMark";
import { NAV_SECTIONS, SYSTEM_ITEMS, isActive, type NavItem } from "./navigation";
import WorkspaceSelector from "./WorkspaceSelector";

export const SIDEBAR_ID = "app-navigation";
export const DRAWER_ID = "app-navigation-drawer";

type Mode = "expanded" | "rail" | "drawer";

function NavLink({
  item,
  pathname,
  mode,
  onNavigate,
}: {
  item: NavItem;
  pathname: string | null;
  mode: Mode;
  onNavigate?: () => void;
}) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  const rail = mode === "rail";
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  // The rail's tooltip: placed against the window (position: fixed) beside
  // the link, so the scrolling list can't clip it; it follows the link while
  // the list or page scrolls.
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const rect = linkRef.current?.getBoundingClientRect();
    if (rect) setTip({ top: rect.top + rect.height / 2, left: rect.right + 12 });
  }, []);
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [tip, place]);
  const showTip = rail ? place : undefined;
  const hideTip = rail ? () => setTip(null) : undefined;

  return (
    <Link
      ref={linkRef}
      href={item.href}
      onClick={() => {
        setTip(null);
        onNavigate?.();
      }}
      onMouseEnter={showTip}
      onMouseLeave={hideTip}
      onFocus={showTip}
      onBlur={hideTip}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center rounded-lg text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
        rail ? "h-10 w-10 justify-center" : "h-9 gap-2.5 px-2.5"
      } ${active ? "bg-brand-50 text-brand-700 font-medium" : "text-slate-600 hover:bg-surface-sunken hover:text-slate-900"}`}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-600" aria-hidden="true" />}
      <Icon
        className={`h-[18px] w-[18px] shrink-0 ${active ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`}
        aria-hidden="true"
      />
      {rail ? (
        <>
          <span className="sr-only">{item.label}</span>
          {/* The visible label on hover and keyboard focus (the link is named by the hidden text). */}
          {tip && (
            <span
              aria-hidden="true"
              data-rail-tooltip=""
              style={{ top: tip.top, left: tip.left }}
              className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-pop"
            >
              {item.label}
            </span>
          )}
        </>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </Link>
  );
}

function SidebarContent({
  mode,
  onNavigate,
  onClose,
  onToggleCollapsed,
}: {
  mode: Mode;
  onNavigate?: () => void;
  onClose?: () => void;
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname();
  const rail = mode === "rail";
  const ToggleIcon = rail ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="flex h-full flex-col bg-white">
      <div className={`h-14 shrink-0 flex items-center border-b border-line ${rail ? "justify-center px-2" : "justify-between px-4"}`}>
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="Vzoniq dashboard"
          className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {rail ? <BrandLogo className="h-8 w-8" /> : <BrandMark tone="light" />}
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-surface-sunken hover:text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className={`shrink-0 border-b border-line ${rail ? "flex justify-center py-3" : "px-3 py-3"}`}>
        <WorkspaceSelector variant={rail ? "rail" : "sidebar"} onExpand={onToggleCollapsed} />
      </div>

      <nav
        aria-label="Main"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-5"
      >
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.label} role="group" aria-label={section.label}>
            {rail ? (
              index > 0 && <div className="mx-2 mb-2 border-t border-line" aria-hidden="true" />
            ) : (
              <p className="px-2.5 mb-1.5 text-label uppercase text-slate-400" aria-hidden="true">
                {section.label}
              </p>
            )}
            <div className={rail ? "flex flex-col items-center gap-1" : "space-y-0.5"}>
              {section.items.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} mode={mode} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
        <div role="group" aria-label="System">
          {rail ? (
            <div className="mx-2 mb-2 border-t border-line" aria-hidden="true" />
          ) : (
            <p className="px-2.5 mb-1.5 text-label uppercase text-slate-400" aria-hidden="true">
              System
            </p>
          )}
          <div className={rail ? "flex flex-col items-center gap-1" : "space-y-0.5"}>
            {SYSTEM_ITEMS.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} mode={mode} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      </nav>

      {onToggleCollapsed && mode !== "drawer" && (
        <div className={`shrink-0 border-t border-line py-2 ${rail ? "flex justify-center" : "px-3"}`}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!rail}
            aria-controls={SIDEBAR_ID}
            aria-label={rail ? "Expand navigation" : "Collapse navigation"}
            title={rail ? "Expand navigation" : "Collapse navigation"}
            className={`inline-flex items-center rounded-lg text-sm text-slate-500 hover:bg-surface-sunken hover:text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              rail ? "h-10 w-10 justify-center" : "h-9 w-full gap-2.5 px-2.5"
            }`}
          >
            <ToggleIcon className="h-[18px] w-[18px]" aria-hidden="true" />
            {!rail && <span>Collapse</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The application's navigation. On large screens it stays beside the page,
 * expanded (240px, labels) or collapsed to a 64px icon rail (labels as
 * tooltips and accessible names); the choice is the caller's (remembered per
 * user). Below that it is a drawer, opened from the top bar: modal, keeps
 * focus inside, closes with Escape, the close button, the backdrop or a
 * link, and returns focus to the menu button.
 */
export default function Sidebar({
  collapsed,
  onToggleCollapsed,
  drawerOpen,
  onCloseDrawer,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  return (
    <>
      <aside
        id={SIDEBAR_ID}
        aria-label="Application navigation"
        className={`hidden lg:block fixed inset-y-0 left-0 z-30 border-r border-line bg-white motion-safe:transition-[width] motion-safe:duration-200 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <SidebarContent mode={collapsed ? "rail" : "expanded"} onToggleCollapsed={onToggleCollapsed} />
      </aside>
      {drawerOpen && <NavigationDrawer onClose={onCloseDrawer} />}
    </>
  );
}

function NavigationDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog opened from the drawer (e.g. Create workspace) closes first.
      const inner = (e.target as HTMLElement | null)?.closest?.('[role="dialog"]');
      if (inner && inner !== panelRef.current) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lg:hidden fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-navy-950/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        id={DRAWER_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="relative h-full w-72 max-w-[85vw] border-r border-line shadow-pop outline-none"
      >
        <SidebarContent mode="drawer" onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  );
}
