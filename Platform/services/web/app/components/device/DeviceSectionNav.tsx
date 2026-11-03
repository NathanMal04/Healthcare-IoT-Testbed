"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  FolderArchive,
  Images,
  LayoutDashboard,
  Maximize2,
  Microchip,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import {
  DEVICE_NAV_LIMITS,
  DEVICE_NAV_VIEW,
  DEVICE_SECTION_LABELS,
  deviceSectionHref,
  type DevicePageSection,
  type DeviceSection,
} from "@/lib/deviceView";
import { readPanel, writePanel } from "@/lib/panelLayout";
import { WIDE_SCREEN, useMediaQuery } from "@/app/components/ui";

const ICONS: Record<DeviceSection, LucideIcon> = {
  overview: LayoutDashboard,
  firmware: Microchip,
  artifacts: FolderArchive,
  images: Images,
  cves: ShieldAlert,
  notebook: NotebookPen,
};

const PAGE_SECTIONS: DevicePageSection[] = ["overview", "firmware", "artifacts", "images", "cves"];

export const DEVICE_SECTION_LINKS_ID = "device-section-links";

interface NavProps {
  deviceId: string;
  active: DeviceSection;
  /** Shown beside a section's name; only exact counts are given. */
  counts: Partial<Record<DeviceSection, number>>;
}

/**
 * The device's sections as real links (each adds a browser history entry):
 * a panel beside the content from 1280px, collapsible to an icon rail and
 * remembered per user; a scrolling strip of tabs above the content below
 * that. The RE Notebook comes last, set apart, and opens full screen.
 */
export default function DeviceSectionNav(props: NavProps) {
  const wide = useMediaQuery(WIDE_SCREEN);
  return wide ? <SidePanel {...props} /> : <Strip {...props} />;
}

/** The remembered expanded/rail choice for the side panel. */
function useCollapsed(): [boolean, () => void] {
  const userId = useAuth().user?.userId;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (userId) setCollapsed(readPanel(userId, DEVICE_NAV_VIEW, DEVICE_NAV_LIMITS).collapsed);
  }, [userId]);
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      if (userId) writePanel(userId, DEVICE_NAV_VIEW, DEVICE_NAV_LIMITS, { width: DEVICE_NAV_LIMITS.initial, collapsed: next });
      return next;
    });
  }, [userId]);
  return [collapsed, toggle];
}

function countText(count: number | undefined): string {
  return count === undefined ? "" : ` (${count})`;
}

function SidePanel({ deviceId, active, counts }: NavProps) {
  const [collapsed, toggle] = useCollapsed();
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <nav
      aria-label="Device sections"
      data-variant="panel"
      data-collapsed={collapsed ? "" : undefined}
      className={`sticky top-[4.5rem] z-10 shrink-0 self-start rounded-xl border border-line bg-white p-1.5 shadow-card motion-safe:transition-[width] motion-safe:duration-200 ${
        collapsed ? "w-14" : "w-52"
      }`}
    >
      <div className={`flex items-center pb-1.5 ${collapsed ? "justify-center" : "justify-between pl-2.5"}`}>
        {!collapsed && <span className="text-label font-semibold uppercase tracking-wide text-slate-400">Device</span>}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={DEVICE_SECTION_LINKS_ID}
          aria-label={collapsed ? "Expand device navigation" : "Collapse device navigation"}
          title={collapsed ? "Expand device navigation" : "Collapse device navigation"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition-colors hover:bg-surface-sunken hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ToggleIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <ul id={DEVICE_SECTION_LINKS_ID} className="space-y-0.5">
        {PAGE_SECTIONS.map((section) => (
          <li key={section}>
            <PanelLink
              href={deviceSectionHref(deviceId, section)}
              section={section}
              active={section === active}
              count={counts[section]}
              collapsed={collapsed}
            />
          </li>
        ))}
      </ul>
      <div className="my-1.5 border-t border-line" aria-hidden="true" />
      <PanelLink href={deviceSectionHref(deviceId, "notebook")} section="notebook" active={false} collapsed={collapsed} />
    </nav>
  );
}

function PanelLink({
  href,
  section,
  active,
  count,
  collapsed,
}: {
  href: string;
  section: DeviceSection;
  active: boolean;
  count?: number;
  collapsed: boolean;
}) {
  const Icon = ICONS[section];
  const label = DEVICE_SECTION_LABELS[section];
  const notebook = section === "notebook";
  return (
    <Link
      href={href}
      scroll={notebook}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center rounded-lg text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
        collapsed ? "mx-auto h-10 w-10 justify-center" : "h-9 gap-2.5 px-2.5"
      } ${active ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-surface-sunken hover:text-slate-900"}`}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-600" aria-hidden="true" />}
      <Icon
        className={`h-[18px] w-[18px] shrink-0 ${active ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`}
        aria-hidden="true"
      />
      {collapsed ? (
        <>
          <span className="sr-only">
            {label}
            {countText(count)}
            {notebook && ", opens full screen"}
          </span>
          {/* The visible name on hover and keyboard focus; the link is named by the hidden text. */}
          <span
            aria-hidden="true"
            data-rail-tooltip=""
            className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-pop group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {label}
          </span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count !== undefined && (
            <span
              className={`rounded-md px-1.5 py-0.5 text-2xs tabular-nums ${active ? "bg-white text-brand-700" : "bg-surface-sunken text-slate-500"}`}
            >
              <span className="sr-only"> (</span>
              {count}
              <span className="sr-only">)</span>
            </span>
          )}
          {notebook && (
            <>
              <Maximize2 className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              <span className="sr-only">, opens full screen</span>
            </>
          )}
        </>
      )}
    </Link>
  );
}

function Strip({ deviceId, active, counts }: NavProps) {
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  // Keep the open section in view when the strip scrolls (narrow screens).
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    // relative: the strip contains everything inside it (screen-reader text
    // included), so the page itself never scrolls sideways.
    <nav aria-label="Device sections" data-variant="strip" className="relative overflow-x-auto overscroll-x-contain border-b border-line">
      <ul className="flex min-w-max items-stretch gap-1">
        {PAGE_SECTIONS.map((section) => {
          const selected = section === active;
          const count = counts[section];
          return (
            <li key={section} className="flex">
              <Link
                ref={selected ? activeRef : undefined}
                href={deviceSectionHref(deviceId, section)}
                scroll={false}
                aria-current={selected ? "page" : undefined}
                className={`relative inline-flex items-center rounded-t-md px-3 py-2.5 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                  selected ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {DEVICE_SECTION_LABELS[section]}
                {count !== undefined && (
                  <span
                    className={`ml-1.5 rounded-md px-1.5 py-0.5 text-2xs tabular-nums ${
                      selected ? "bg-brand-50 text-brand-700" : "bg-surface-sunken text-slate-500"
                    }`}
                  >
                    <span className="sr-only"> (</span>
                    {count}
                    <span className="sr-only">)</span>
                  </span>
                )}
                {selected && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-600" aria-hidden="true" />}
              </Link>
            </li>
          );
        })}
        <li className="flex items-center pl-1" aria-hidden="true">
          <span className="h-5 w-px bg-line" />
        </li>
        <li className="flex">
          <Link
            href={deviceSectionHref(deviceId, "notebook")}
            className="inline-flex items-center gap-1.5 rounded-t-md px-3 py-2.5 text-sm font-medium whitespace-nowrap text-slate-500 outline-none transition-colors hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
          >
            <NotebookPen className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {DEVICE_SECTION_LABELS.notebook}
            <Maximize2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <span className="sr-only">, opens full screen</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
